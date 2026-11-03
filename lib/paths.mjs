// Where council-board keeps its configuration (agents.json, policy.json, house-rules.md)
// and its data (the message log, debate records, Codex runs). Nothing lives in the repo.
//   macOS:  ~/Library/Application Support/Council Board  (config and data together)
//   Linux:  $XDG_CONFIG_HOME/council-board and $XDG_DATA_HOME/council-board
//   Any OS: BOARD_HOME=<dir> puts both in one folder (tests, portable setups).
import os from 'node:os';
import path from 'node:path';

export function boardDirs(env = process.env, platform = process.platform) {
  if (env.BOARD_HOME) {
    const dir = path.resolve(expandHome(env.BOARD_HOME, env));
    return { config: dir, data: dir };
  }
  const home = env.HOME || os.homedir();
  if (platform === 'darwin') {
    const dir = path.join(home, 'Library', 'Application Support', 'Council Board');
    return { config: dir, data: dir };
  }
  return {
    config: path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'council-board'),
    data: path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'council-board'),
  };
}

export function expandHome(p, env = process.env) {
  if (!p) return p;
  return String(p).replace(/^~(?=\/|$)/, env.HOME || os.homedir());
}

const dirs = boardDirs();
export const CONFIG_DIR = dirs.config;
export const DATA_DIR = dirs.data;
