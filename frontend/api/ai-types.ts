export type AiCredentialStorage = "none" | "encrypted-archive" | "system-keychain";

export interface AiTransportRequest {
    providerId: string;
    endpoint: string;
    confirmedEndpoint: string;
    model: string;
    accept: string;
    requestBody: string;
    requestBodyHash: string;
    confirmedBodyHash: string;
    credentialStorage: AiCredentialStorage;
    credential: string;
}

export interface AiTransportResult {
    status: number;
    contentType: string;
    responseBytes: number;
    complete: boolean;
    cancelled?: boolean;
    errorMessage?: string;
}
