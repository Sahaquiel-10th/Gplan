import { NextFunction, Request, Response } from "express";
import { store } from "./db.js";
import { verifyToken } from "./security.js";
import { Role, User } from "./types.js";

declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

export function auth(secret: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
    const payload = token ? verifyToken(token, secret) : null;
    if (!payload) return res.status(401).json({ error: "未登录或登录已过期" });

    const db = await store.read();
    const user = db.users.find((item) => item.id === payload.sub && item.enabled);
    if (!user) return res.status(401).json({ error: "账号不可用" });

    req.user = user;
    next();
  };
}

export function requireRole(role: Role) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.user?.role !== role) return res.status(403).json({ error: "权限不足" });
    next();
  };
}

export function asyncRoute(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}
