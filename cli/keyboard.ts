export function controlKey(input: string, ctrlModifier: boolean): string | null {
  if (ctrlModifier && input.length === 1) return input.toLowerCase();
  if (input.length !== 1) return null;
  const code = input.charCodeAt(0);
  if (code < 1 || code > 26 || code === 9 || code === 10 || code === 13) return null;
  return String.fromCharCode(code + 96);
}
