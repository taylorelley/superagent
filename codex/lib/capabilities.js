/** Evidence for plugin completion and, separately, strict host parity. */
export const REQUIRED_CAPABILITIES = Object.freeze([
  'skills',
  'roles',
  'models',
  'permissions',
  'lifecycle',
  'context',
  'commands',
  'panel',
  'installation',
]);

export function assessCapabilities(evidence = {}, version = null) {
  const capabilities = Object.fromEntries(
    REQUIRED_CAPABILITIES.map((name) => {
      const proof = evidence[name];
      const valid = Boolean(
        version &&
        proof?.version === version &&
        typeof proof?.command === 'string' &&
        proof.command.trim() &&
        typeof proof?.observation === 'string' &&
        proof.observation.trim(),
      );
      const verified = valid && proof.status === 'verified';
      const adapted =
        valid &&
        proof.status === 'adapted' &&
        typeof proof.adaptation === 'string' &&
        proof.adaptation.trim();
      return [name, verified || adapted ? { ...proof } : { status: 'unverified' }];
    }),
  );
  const missing = REQUIRED_CAPABILITIES.filter((name) => capabilities[name].status !== 'verified');
  const pluginMissing = REQUIRED_CAPABILITIES.filter(
    (name) => capabilities[name].status === 'unverified',
  );
  return {
    version,
    capabilities,
    missing,
    fullParity: missing.length === 0,
    pluginMissing,
    pluginComplete: pluginMissing.length === 0,
  };
}
