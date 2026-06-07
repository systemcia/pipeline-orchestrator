export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isMacOS(): boolean {
  return process.platform === "darwin";
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
