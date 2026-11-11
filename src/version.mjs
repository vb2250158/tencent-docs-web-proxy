import metadata from '../package.json' with { type: 'json' };

/** Keep the CLI and HTTP version aligned with the package manifest. */
export const VERSION = metadata.version;
