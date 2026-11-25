import { AsyncLocalStorage } from "node:async_hooks";
import type { SignInScope } from "./scope.ts";

/**
 * The sign-in being started by a server action. Auth.js builds its config without a
 * request inside server actions, so this carries the scope there; everywhere else
 * (page renders, the proxy) no sign-in is in progress and no lookup is made.
 */
export const signInContext = new AsyncLocalStorage<SignInScope>();
