use super::model::{
    ApplicationAudioCounters, ApplicationAudioTarget, PcmChunk, TrackSignal,
};
use std::{
    sync::{
        atomic::Ordering,
        mpsc::{self, Receiver, SyncSender, TryRecvError},
        Arc,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

#[cfg(any(target_os = "windows", target_os = "linux"))]
mod windows_linux;
#[cfg(target_os = "macos")]
mod macos;

#[cfg(any(target_os = "windows", target_os = "linux"))]
use windows_linux::{
    poll_process_audio, start_application_audio_stream, stop_application_audio_stream,
};
#[cfg(target_os = "macos")]
use macos::{start_application_audio_stream, stop_application_audio_stream};

enum ApplicationAudioCommand {
    Start(SyncSender<Result<(), String>>),
    Pause(SyncSender<Result<(), String>>),
    Resume(SyncSender<Result<(), String>>),
    Stop(SyncSender<()>),
}

pub(super) struct ApplicationAudioCapture {
    commands: mpsc::Sender<ApplicationAudioCommand>,
    worker: Option<JoinHandle<()>>,
}

impl ApplicationAudioCapture {
    pub(super) fn new(
        target: ApplicationAudioTarget,
        sender: SyncSender<PcmChunk>,
        signal: Arc<TrackSignal>,
    ) -> Result<Self, String> {
        let (commands, receiver) = mpsc::channel();
        let worker = thread::Builder::new()
            .name("tutorux-application-audio".into())
            .spawn(move || run_application_audio_capture(target, sender, signal, receiver))
            .map_err(|_| "The application-audio worker could not be started.".to_owned())?;
        Ok(Self {
            commands,
            worker: Some(worker),
        })
    }

    pub(super) fn start(&self) -> Result<(), String> {
        self.request(|reply| ApplicationAudioCommand::Start(reply))
    }

    pub(super) fn pause(&self) -> Result<(), String> {
        self.request(|reply| ApplicationAudioCommand::Pause(reply))
    }

    pub(super) fn resume(&self) -> Result<(), String> {
        self.request(|reply| ApplicationAudioCommand::Resume(reply))
    }

    fn request(
        &self,
        command: impl FnOnce(SyncSender<Result<(), String>>) -> ApplicationAudioCommand,
    ) -> Result<(), String> {
        let (reply, response) = mpsc::sync_channel(1);
        self.commands
            .send(command(reply))
            .map_err(|_| "The application-audio worker has stopped.".to_owned())?;
        response
            .recv_timeout(Duration::from_secs(20))
            .map_err(|_| "The application-audio source did not respond in time.".to_owned())?
    }

    pub(super) fn stop(&mut self) -> bool {
        if let Some(worker) = self.worker.take() {
            let (reply, response) = mpsc::sync_channel(1);
            let _ = self.commands.send(ApplicationAudioCommand::Stop(reply));
            if response.recv_timeout(Duration::from_secs(5)).is_ok() {
                worker.join().is_ok()
            } else {
                // A native capture call can be stuck inside an OS callback; never block the UI
                // command indefinitely while tearing down an application source.
                drop(worker);
                false
            }
        } else {
            true
        }
    }
}

impl Drop for ApplicationAudioCapture {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
pub(super) struct NativeApplicationAudioStream(flexaudio::Stream);

#[cfg(target_os = "macos")]
pub(super) struct NativeApplicationAudioStream(screencapturekit::prelude::SCStream);

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
pub(super) struct NativeApplicationAudioStream;

fn run_application_audio_capture(
    target: ApplicationAudioTarget,
    sender: SyncSender<PcmChunk>,
    signal: Arc<TrackSignal>,
    commands: Receiver<ApplicationAudioCommand>,
) {
    let counters = Arc::new(ApplicationAudioCounters::new());
    let mut expected_backend_frame_index = None;
    let mut stream: Option<NativeApplicationAudioStream> = None;
    loop {
        if stream.is_none() {
            match commands.recv() {
                Ok(ApplicationAudioCommand::Start(reply))
                | Ok(ApplicationAudioCommand::Resume(reply)) => {
                    let opened = start_application_audio_stream(
                        &target,
                        sender.clone(),
                        Arc::clone(&signal),
                        Arc::clone(&counters),
                    );
                    match opened {
                        Ok(opened) => {
                            stream = Some(opened);
                            let _ = reply.send(Ok(()));
                        }
                        Err(error) => {
                            signal.fail(error.clone());
                            let _ = reply.send(Err(error));
                        }
                    }
                }
                Ok(ApplicationAudioCommand::Pause(reply)) => {
                    let _ = reply.send(Ok(()));
                }
                Ok(ApplicationAudioCommand::Stop(reply)) => {
                    signal.accepting.store(false, Ordering::Release);
                    let _ = reply.send(());
                    return;
                }
                Err(_) => return,
            }
            continue;
        }

        let mut should_stop = false;
        loop {
            match commands.try_recv() {
                Ok(ApplicationAudioCommand::Start(reply)) => {
                    let _ = reply.send(Err(
                        "The application-audio source has already started.".to_owned()
                    ));
                }
                Ok(ApplicationAudioCommand::Pause(reply)) => {
                    signal.accepting.store(false, Ordering::Release);
                    if let Some(mut active) = stream.take() {
                        stop_application_audio_stream(&mut active);
                    }
                    expected_backend_frame_index = None;
                    let _ = reply.send(Ok(()));
                    break;
                }
                Ok(ApplicationAudioCommand::Resume(reply)) => {
                    let _ = reply.send(Err(
                        "The application-audio source is already recording.".to_owned()
                    ));
                }
                Ok(ApplicationAudioCommand::Stop(reply)) => {
                    signal.accepting.store(false, Ordering::Release);
                    if let Some(mut active) = stream.take() {
                        stop_application_audio_stream(&mut active);
                    }
                    let _ = reply.send(());
                    should_stop = true;
                    break;
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    should_stop = true;
                    break;
                }
            }
        }
        if should_stop {
            return;
        }

        #[cfg(any(target_os = "windows", target_os = "linux"))]
        if let Some(NativeApplicationAudioStream(active)) = stream.as_mut() {
            poll_process_audio(
                active,
                &sender,
                &signal,
                &counters,
                &mut expected_backend_frame_index,
            );
        }
        if signal.failure_message().is_some() {
            if let Some(mut failed) = stream.take() {
                stop_application_audio_stream(&mut failed);
            }
        }
        thread::sleep(Duration::from_millis(4));
    }
}
#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
fn start_application_audio_stream(
    _target: &ApplicationAudioTarget,
    _sender: SyncSender<PcmChunk>,
    _signal: Arc<TrackSignal>,
    _counters: Arc<ApplicationAudioCounters>,
) -> Result<NativeApplicationAudioStream, String> {
    Err(super::support::application_audio_unavailable_message().to_owned())
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
fn stop_application_audio_stream(_stream: &mut NativeApplicationAudioStream) {}
