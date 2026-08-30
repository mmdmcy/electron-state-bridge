export const SYNTHETIC_LINES = [
  'We should keep the canonical write path in the main process.',
  'The renderer needs an immediate local snapshot for React reads.',
  'Revision gaps should trigger a full snapshot request.',
  'Typed actions preserve concurrent appends better than array replacement.',
  'The blocking path must stay limited to small pure UI actions.'
] as const;

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
});

export function identifier(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function formatTime(value: number | null): string {
  return value === null ? '—' : timeFormatter.format(value);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown state bridge error.';
}
