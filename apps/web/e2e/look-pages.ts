// The pages look.spec.ts checks (axe, brand, phone width): every page in the role matrix,
// as the first persona allowed to see it, plus the pages for people who are not signed
// in, and the error pages. routes.spec.ts checks every page in the app is here.
import { routes, state, type PersonaName } from "./matrix.ts";

const { a } = state;

export interface LookPage {
  name: string;
  path: string;
  persona: PersonaName;
}

export const lookPages: LookPage[] = [
  ...routes
    .filter((r) => !r.api && r.allowed.length > 0)
    .map((r) => ({ name: r.path, path: r.path, persona: r.allowed[0] as PersonaName })),
  { name: "landing page", path: "/", persona: "anonymous" },
  { name: "operator sign-in", path: "/operator/sign-in", persona: "anonymous" },
  { name: "operator sign-in, refused", path: "/operator/sign-in?error=1", persona: "anonymous" },
  { name: "tenant sign-in", path: `/t/${a.slug}/sign-in`, persona: "anonymous" },
  { name: "tenant sign-in, link sent", path: `/t/${a.slug}/sign-in?sent=1`, persona: "anonymous" },
  {
    // A long address must wrap, not widen the page.
    name: "email link confirmation",
    path: `/t/${a.slug}/sign-in/verify?email=firstname.lastname%40subsidiary.longcompanyname.co.uk&token=x`,
    persona: "anonymous",
  },
  { name: "error page", path: "/test/error", persona: "anonymous" },
  { name: "review screen", path: `/t/${a.slug}/jobs/${state.reviewJobId}`, persona: "userA" },
  { name: "sign-in error", path: "/sign-in/error", persona: "anonymous" },
  { name: "not found", path: "/no-such-page", persona: "anonymous" },
  { name: "no access (forbidden)", path: "/operator", persona: "userA" },
  {
    name: "documents, upload refused",
    path: `/t/${a.slug}/documents?error=too-large`,
    persona: "userA",
  },
];
