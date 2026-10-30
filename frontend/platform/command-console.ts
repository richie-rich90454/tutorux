export interface CommandConsoleAvailability {
  readonly available: boolean;
  readonly message: string;
}

export interface CommandConsoleResult {
  readonly exitCode: number;
  readonly cancelled: boolean;
  readonly archiveChanged: boolean;
}

export interface CommandConsoleRun {
  readonly completion: Promise<CommandConsoleResult>;
  cancel(): Promise<void>;
}
