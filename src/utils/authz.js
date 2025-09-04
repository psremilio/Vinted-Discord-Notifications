import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rolesPath = path.resolve(__dirname, '../../config/roles.json');
let cache = null; let mtime = 0;

function ensureFile() {
  try {
    if (!fs.existsSync(rolesPath)) {
      fs.mkdirSync(path.dirname(rolesPath), { recursive: true });
      fs.writeFileSync(rolesPath, JSON.stringify({ allow: [] }, null, 2));
    }
  } catch {}
}

function load() {
  ensureFile();
  try {
    const stat = fs.statSync(rolesPath);
    if (!cache || stat.mtimeMs !== mtime) {
      cache = JSON.parse(fs.readFileSync(rolesPath, 'utf8'));
      if (!Array.isArray(cache.allow)) cache.allow = [];
      mtime = stat.mtimeMs;
    }
  } catch {
    cache = { allow: [] };
  }
  return cache;
}

function save(cfg) {
  try {
    fs.writeFileSync(rolesPath, JSON.stringify(cfg, null, 2));
    mtime = fs.statSync(rolesPath).mtimeMs;
    cache = cfg;
  } catch {}
}

export function isAdmin(interaction) {
  try {
    if (interaction.user?.id && interaction.guild?.ownerId && interaction.user.id === interaction.guild.ownerId) return true;
  } catch {}
  try {
    const perms = interaction.memberPermissions;
    return Boolean(perms?.has?.('Administrator'));
  } catch { return false; }
}

export function isAuthorized(interaction) {
  // Admins always allowed
  if (isAdmin(interaction)) return true;
  // Require guild context
  if (!interaction?.inGuild?.() && !interaction?.guildId) return false;
  const cfg = load();
  const allow = new Set((cfg.allow || []).map(String));
  // Policy: when allowlist is empty, allow by default (can be locked via env)
  const OPEN_DEFAULT = String(process.env.COMMANDS_ALLOW_ALL_WHEN_EMPTY || '1') === '1';
  if (allow.size === 0) return OPEN_DEFAULT;
  const roles = interaction?.member?.roles?.cache;
  if (!roles || roles.size === 0) return false;
  for (const roleId of allow) if (roles.has(roleId)) return true;
  return false;
}

export function listAllowed() {
  return [...new Set((load().allow || []).map(String))];
}

export function addAllowed(roleId) {
  const cfg = load();
  const set = new Set((cfg.allow || []).map(String));
  set.add(String(roleId));
  cfg.allow = [...set];
  save(cfg);
  return cfg.allow;
}

export function removeAllowed(roleId) {
  const cfg = load();
  const set = new Set((cfg.allow || []).map(String));
  set.delete(String(roleId));
  cfg.allow = [...set];
  save(cfg);
  return cfg.allow;
}

export function resetAllowed() {
  const cfg = { allow: [] };
  save(cfg);
  return cfg.allow;
}
