# DayZ Universal Api

> ⚠️ **EXPERIMENTAL — NO SUPPORT PROVIDED**
>
> This is a very experimental test project. It is shared as-is for reference and exploration only.
> **I will not provide support, bug fixes, or assistance of any kind.** Use at your own risk.
> Pull requests are welcome, but there is no guarantee they will be reviewed or merged.

This is a fork of [DaemonForge's DayZ Universal Api](https://github.com/daemonforge/DayZ-UniveralApi). The original project provides a Universal Api Mod and Webservice backend for DayZ server hosters, along with an easy-to-use API wrapper for modders building hived and cross-server mods. This fork adds experimental SQL (SQLite/PostgreSQL) backend support on top of the original MongoDB implementation.

> **Note:** The web service is primarily tested against MongoDB. SQLite and PostgreSQL backend support exists in `db.js` but is not fully wired through all authentication paths and should be considered incomplete.

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
