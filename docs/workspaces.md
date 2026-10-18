# Workspaces: one person in several, and the platform's owners

Every client business is a **workspace** (an `Organization` row). Its people,
channels, conversations, customers, templates and settings are its own: the
tenant-scoped Prisma client refuses anything across the line (see
`docs/tenant-release-gate.md`, `tools/check-tenant-isolation.ts`).

## Sign-in: a Login, and a place in each workspace

- A **Login** is one per email address, and belongs to no workspace. It holds
  what proves who you are: the password, the second factor and its recovery
  codes, a pending reset, and the workspace you were last in.
- A **User** is your place in one workspace: your name there, your role, teams,
  availability and signature. Each User points at its Login (`User.loginId`,
  unique per workspace).

So one address can be an admin here and an agent there, with **one password and
one second factor** for all of them. Changing the password, turning 2FA on or
off, or resetting it changes it everywhere, and ends the person's other sessions
in every workspace. A remembered device is remembered for the person, not the
workspace.

Signing in lands you in the workspace you were last in. A session is always one
workspace: the JWT names the User, and the guard binds that User's workspace.

`20261018090000_logins` made one Login per address from the existing users (the
earliest account's credentials), and moved recovery codes onto them. An account
made later straight into the table, by a script or the seed, is picked up the
first time its address signs in.

The store never reads or changes a Login except through a User in the workspace
the request acts for. The one exception is the person's own list of
workspaces, and moving between them.

## Moving between workspaces

- Web: the account menu (your avatar on the rail) lists your workspaces once
  you're in more than one. The sidebar shows the one you're in.
- App: Settings › Workspaces.

`POST /auth/switch {orgId}` ends this session and opens one as your place in
that workspace. A browser gets a new cookie and reloads. A phone gets a new
token, stores it, resets its caches and socket, and registers for push again.
Push goes to the workspace the phone is signed in to.

## Adding someone who's already in another workspace

Settings › People › Add, as usual. If the address already signs in, they're
added with the password they have and emailed to say so. There's no invite. If
the address is already in this workspace, the API refuses with 409.

## The platform's owners

A **platform owner** runs the service itself. They are:

- the addresses in `PLATFORM_OWNERS` (comma-separated), when that is set;
- otherwise, the admins of the platform's own workspace (`PLATFORM_ORG_ID`,
  normally `org_swiftee`). Managers never are.

Only platform owners see Settings › **Workspaces** and Settings ›
**Integrations**.

- **Workspaces** lists every workspace with its people, channels and
  conversations.
  - **New workspace** makes one, with a General team and its first admin. The
    admin is invited to set a password, or simply added if they already sign
    in.
  - **Open** moves you into a workspace. If you aren't in it, you're added as
    an admin, in its people list where its own admins can see you. Nobody
    else can switch into a workspace they aren't in.
- **Integrations** are platform-wide: Google, Meta, storage, mail, AI, push.
  Only an owner can read the details or change them. Everyone else gets just
  which features are switched on, so AI Polish, transcription and the rest
  still show up in every workspace.

## Managing a workspace, and its life

**Manage** on a workspace, in Settings › Workspaces, works from outside it, so
the owner doesn't have to open the workspace:

- **Name**: rename it. Its people see the new name in their switcher and
  sidebar.
- **People**: add someone (invited, or added if they already sign in), change a
  role, re-send an invite to someone who hasn't set a password yet, or remove
  someone. A workspace always keeps at least one admin.
- **Status**:

| Status | What happens | Back |
| --- | --- | --- |
| Suspended | Everyone in it is signed out at once and can't sign in again (they're told it's suspended once their password is right). Its WhatsApp numbers, chat widget and Gmail take nothing in and send nothing out, queued messages included, and its jobs pass it by. Everything is kept. | Reactivate |
| Archived | The same freeze, put away (hidden from the list unless you show archived ones), and kept for ever. | Unarchive |
| Being deleted | The same freeze, and wiped for good 30 days later. | Restore, any time before then |
| Delete now | Wiped at once, after you type its name. Can't be undone. | — |

The platform's own workspace can't be suspended, archived or deleted. Nor can
the one you're in: switch out of it first.

Every closed state is enforced in one place: the tenant-scoped database client
refuses any query for a frozen workspace (`tenancy/workspace-status.ts`). That
covers requests, webhooks and background jobs alike. The only way in is an
owner managing it from Settings › Workspaces. Inbound channel lookups and the
job sweeps also skip frozen workspaces, so they stay quiet rather than log
errors.

**The wipe** (`data/workspace-purge.ts`) reads Postgres's own foreign keys to
find what belongs to a workspace:

- rows of tables with its `orgId`;
- rows owned through a key from those (CASCADE, RESTRICT, NO ACTION);
- never rows that only refer to it (SET NULL).

It deletes children before parents, all in one transaction, so a table added
later is wiped with the rest. Its people's sign-ins go too, unless they're in
another workspace. Its files are deleted from storage once its rows are gone.
Workspaces being deleted are wiped by an hourly sweep once their 30 days are
up.

## Email in a client's workspace

Outside the platform's own workspace, email connects through **Gmail** (Connect
Gmail). An inbox on the platform's own mail service is the platform's alone:
the API refuses it with 400, and the web doesn't offer it.

## Checks

| Check | Proves |
| --- | --- |
| `pnpm check:workspaces-http` (CI, Postgres) | Owners and managers; making a workspace and inviting its admin; accepting the invite in a browser still signed in elsewhere; joining with an existing password; switching and the old session ending; landing where you last were; opening a workspace you aren't in; a password change reaching every workspace; Gmail-only email |
| `pnpm check:workspace-lifecycle-http` (CI, Postgres) | The wipe covers every table; managing from outside (rename, people, never the last admin); suspended: signed out, can't sign in, channels take nothing in, nobody switches in; archive, delete and restore; delete now: every table's count back to what it was before the workspace existed |
| `pnpm check:tenant-isolation` | A Login can't be reached through another workspace's user: password, 2FA, sessions |
| `pnpm check:tenant-http` | Integrations: other workspaces see what's on, never the details, and can't change them |
