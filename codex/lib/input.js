/** Read one JSON hook event; the native host may keep stdin open. */
export async function readHookInput(stream) {
  let text = '';
  for await (const chunk of stream) {
    text += chunk;
    if (Buffer.byteLength(text, 'utf8') > 4 * 1024 * 1024)
      throw new Error('Hook input exceeds 4 MiB');
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      continue;
    }
    return value;
  }
  return JSON.parse(text);
}
