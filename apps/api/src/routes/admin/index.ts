import { Hono } from 'hono';

import { adminApi } from './api.js';
import { adminUi } from './ui.js';

/**
 * Mount-volgorde: JSON-API onder `/api/*` eerst zodat die voorrang
 * krijgt op de wildcard-cookie-middleware in de UI router.
 */
export const adminRoute = new Hono();

adminRoute.route('/api', adminApi);
adminRoute.route('/', adminUi);
