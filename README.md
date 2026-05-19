# DayZ Universal Api

> ⚠️ **EXPERIMENTAL — NO SUPPORT PROVIDED**
>
> This is a very experimental test project. It is shared as-is for reference and exploration only.
> **I will not provide support, bug fixes, or assistance of any kind.** Use at your own risk.
> Pull requests are welcome, but there is no guarantee they will be reviewed or merged.

This is a fork of [DaemonForge's DayZ Universal Api](https://github.com/daemonforge/DayZ-UniveralApi). The original project provides a Universal API Mod and web service backend for DayZ server hosters, along with an easy-to-use API wrapper for modders building hived and cross-server mods. This fork adds experimental SQL (SQLite/PostgreSQL) backend support on top of the original MongoDB implementation.

> **Note:** The web service is primarily tested against MongoDB. SQLite and PostgreSQL backend support exists in `db.js`, but it should still be considered experimental and less well-tested than the MongoDB backend.

Developer documentation (from the original project) is available here: https://github.com/daemonforge/DayZ-UniveralApi/wiki/Developer-Reference

### Database Functions
- Load/Save Objects (JSON)
- Update Objects (can set sub-elements/variables including Pull and Push from Arrays)
- Transactions (increment floats/ints in database with consistency across multiple servers)
- Queries (MongoDB Queries)

### Discord Functions
- Simple web interface for players to link their Steam accounts to Discord (customizable for server owners)
- Add/Remove Roles
- Get User (returns an object with current Roles and Discord ID/Name)
- Send Message (sends a DM from bot to player; player doesn't have to be connected to DayZ at the time)
- Create/Edit/Delete Channels
- Send Message to Channels
- Get Messages from Channels
- Move User to Voice Channel
- Mute User in Voice Channel
- Kick User from Voice Channel
- Get User's current Voice Channel

### Other Features
- Quantum Random Numbers
- Toxicity Checker (TensorFlow Toxicity)
- Translate (Libre Translate)
- And more

## Running the Linux Backend

The `DayZWebService` backend is a **Node.js application** — there is no traditional compile step. You can either run it directly with Node.js or package it into a standalone Linux binary.

### Option 1: Run directly with Node.js (recommended)

Requires Node.js (v16+) installed on the Linux machine.

```bash
cd DayZWebService
npm install
node setup.js        # creates config.json with a unique ServerAuth
# Edit config.json — set your database details, change Port to e.g. 8443 for local use
# (Port 443 requires elevated privileges on Linux)
npm start
```

`setup.js` copies `sample-config.json` to `config.json` and replaces `ServerAuth` with a freshly generated random value. It will not overwrite an existing `config.json`.

### Option 2: Package into a standalone Linux binary with `pkg`

Produces a self-contained executable that does not require Node.js on the target machine.

```bash
cd DayZWebService
npm install
npx pkg . --targets node16-linux-x64 --output dayz-webservice-linux
```

Run the output binary on any Linux x64 server:

```bash
./dayz-webservice-linux
```

> **Note:** SQLite uses `better-sqlite3`, which is a native addon. With `pkg`, native addons generally cannot be loaded from the bundled snapshot, so copying only `better_sqlite3.node` next to the executable is usually **not enough**.
>
> If you plan to use SQLite, the most reliable option is to run the backend directly with Node.js (Option 1). If you still want to use `pkg`, deploy the executable **alongside the full `better-sqlite3` package layout** so `require('better-sqlite3')` can resolve its JavaScript wrapper and native binary from `node_modules/better-sqlite3/`.
>
> Example deployment layout:
> ```bash
> mkdir -p deploy/node_modules
> cp dayz-webservice-linux deploy/
> cp -R node_modules/better-sqlite3 deploy/node_modules/
> cd deploy
> ./dayz-webservice-linux
> ```

### Database Configuration

Run `node setup.js` (or copy `sample-config.json` to `config.json` manually) and set `DBType` to match your database:

| `DBType` value | Database |
|---|---|
| `"mongodb"` | MongoDB (default) |
| `"sqlite"` or `"sqlite3"` | SQLite3 (file-based, simplest for local use) |
| `"postgresql"`, `"postgres"`, or `"pg"` | PostgreSQL |

**Example — SQLite (no separate server required):**
```json
{
  "DBType": "sqlite",
  "DBServer": "./mydb.sqlite"
}
```
