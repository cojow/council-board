import test from 'node:test';
import { moduleURL, sandbox, succeeds } from './helpers.mjs';

test('paths: BOARD_HOME overrides platform and XDG settings and expands home', (t) => {
  const s = sandbox(t);
  succeeds(s.evaluate(`
    const { boardDirs, expandHome, CONFIG_DIR, DATA_DIR } = await import(${JSON.stringify(moduleURL('lib/paths.mjs'))});
    const home = process.env.HOME;
    const portable = path.join(home, 'portable');
    for (const platform of ['darwin', 'linux']) {
      assert.deepEqual(boardDirs({ HOME: home, BOARD_HOME: '~/portable', XDG_CONFIG_HOME: '/unused' }, platform), { config: portable, data: portable });
    }
    assert.equal(CONFIG_DIR, process.env.BOARD_HOME);
    assert.equal(DATA_DIR, process.env.BOARD_HOME);
    assert.equal(expandHome('~'), home);
    assert.equal(expandHome('~/nested'), path.join(home, 'nested'));
    assert.equal(expandHome('~someone/nested'), '~someone/nested');
    assert.equal(expandHome('relative'), 'relative');
    assert.equal(expandHome(''), '');
    assert.equal(expandHome(null), null);
  `));
});

test('paths: macOS uses Application Support; Linux respects independent XDG defaults', (t) => {
  const s = sandbox(t);
  succeeds(s.evaluate(`
    const { boardDirs } = await import(${JSON.stringify(moduleURL('lib/paths.mjs'))});
    const HOME = process.env.HOME;
    const mac = path.join(HOME, 'Library', 'Application Support', 'Council Board');
    assert.deepEqual(boardDirs({ HOME }, 'darwin'), { config: mac, data: mac });
    const config = path.join(HOME, '.config/council-board');
    const data = path.join(HOME, '.local/share/council-board');
    const xConfig = path.join(HOME, 'xdg-config');
    const xData = path.join(HOME, 'xdg-data');
    assert.deepEqual(boardDirs({ HOME }, 'linux'), { config, data });
    assert.deepEqual(boardDirs({ HOME, XDG_CONFIG_HOME: xConfig, XDG_DATA_HOME: xData }, 'linux'), { config: path.join(xConfig, 'council-board'), data: path.join(xData, 'council-board') });
    assert.deepEqual(boardDirs({ HOME, XDG_CONFIG_HOME: xConfig }, 'linux'), { config: path.join(xConfig, 'council-board'), data });
    assert.deepEqual(boardDirs({ HOME, XDG_DATA_HOME: xData }, 'linux'), { config, data: path.join(xData, 'council-board') });
    assert.deepEqual(boardDirs({ HOME, XDG_CONFIG_HOME: '', XDG_DATA_HOME: '' }, 'linux'), { config, data });
  `));
});
