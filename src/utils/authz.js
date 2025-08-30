import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rolesPath = path.resolve(__dirname, '../../config/roles.json');
let cached; let mtime = 0;

function loadConfig() {
  try {
    const stat = fs.statSync(rolesPath);
    if (!cached || stat.mtimeMs !== mtime) {
      cached = JSON.parse(fs.readFileSync(rolesPath, 'utf8'));
      mtime = stat.mtimeMs;
    }
  } catch {
    // fallback to env-only when file missing
    cached = null;
  }
  return cached;
}

function envList(name) {
  return String(process.env[name] || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function allowedRolesFor(commandName) {
  const cfg = loadConfig();
  const fromFile = new Set([
    ...((cfg?.global || [])),
    ...((cfg?.commands?.[commandName] || [])),
  ].map(String));

  const fromEnv = new Set([
    ...envList('COMMAND_ROLE_IDS'),
    ...envList(`COMMAND_ROLE_IDS_${String(commandName || '').toUpperCase().replace(/[^A-Z0-9]/g,'_')}`),
  ].map(String));

  return new Set([...fromFile, ...fromEnv]);
}

function hasBypass(interaction) {
  try {
    if (interaction.user?.id && interaction.guild?.ownerId && interaction.user.id === interaction.guild.ownerId) return true;
  } catch {}
  try {
    const perms = interaction.memberPermissions;
    return perms?.has?.('Administrator') || perms?.has?.('ManageGuild') || false;
  } catch { return false; }
}

export function isAuthorized(interaction, commandName) {
  // DMs unsupported; require guild context to evaluate roles
  if (!interaction?.inGuild?.() && !interaction?.guildId) return false;
  if (hasBypass(interaction)) return true;

  const allow = allowedRolesFor(commandName);
  if (!allow || allow.size === 0) return true; // no restriction configured

  const roles = interaction?.member?.roles?.cache;
  if (!roles || roles.size === 0) return false;
  for (const roleId of allow) {
    if (roles.has(roleId)) return true;
  }
  return false;
}

