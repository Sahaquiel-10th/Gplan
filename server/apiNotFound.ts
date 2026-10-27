import type { RequestHandler } from 'express';

// Never let a missing API endpoint fall through to the SPA's successful HTML response.
export const apiNotFound: RequestHandler = (_req, res) => {
  res.status(404).json({ code: 40401, message: '接口不存在', request_id: res.locals.requestId });
};
