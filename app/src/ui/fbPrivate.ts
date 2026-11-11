import { isWeb } from './tokens';

/** Marks a displayed name or amount on the web. A feedback picture paints over it. */
export const fbPrivate = isWeb ? { dataSet: { fbPrivate: true } } : {};
