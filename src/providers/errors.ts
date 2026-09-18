export class ProviderSendError extends Error {
  constructor(
    message: string,
    readonly deliveryUncertain: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ProviderSendError';
  }
}

export function isProviderSendError(error: unknown): error is ProviderSendError {
  return error instanceof ProviderSendError;
}
