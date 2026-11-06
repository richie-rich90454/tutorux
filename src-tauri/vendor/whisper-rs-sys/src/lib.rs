#![allow(non_upper_case_globals)]
#![allow(non_camel_case_types)]
#![allow(non_snake_case)]

include!(concat!(env!("OUT_DIR"), "/bindings.rs"));

extern "C" {
    #[link_name = "whisper_ggml_log_set"]
    pub fn whisper_ggml_log_set(
        log_callback: ggml_log_callback,
        user_data: *mut ::std::os::raw::c_void,
    );
}
