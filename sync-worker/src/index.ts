import { createApp } from './app.ts';
import type { Env } from './types.ts';

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return createApp(env)(request);
  },
} satisfies ExportedHandler<Env>;
