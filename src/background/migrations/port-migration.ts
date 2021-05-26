import { app, remote } from "electron";
import path from "path";
import os from "os";
import { Pier, PierService } from "../services/pier-service";
import fs from 'fs-extra';
import { each, whilst } from 'async';
import { send } from "../server/ipc";

const electronApp = app || remote.app;

function getLinuxPath(app: string) {
    const segments = process.env.SNAP_USER_COMMON.split(path.sep);
    const common = segments.pop();
    segments.pop();

    return path.join(path.sep, ...segments, app, common, '.config', electronApp.getName());
}

function getMacPath(app: string) {
    const segments = electronApp.getPath('userData').split(path.sep);
    segments.pop();
    segments.push(app);

    return path.join(path.sep, ...segments);
}

async function getMigrationPath(suffix = '', old = true, common = false): Promise<string> {
    const app = old ? 'taisho' : electronApp.getName();
    let pierPath = getMacPath(app);
    console.log('std path', pierPath)
    
    if (common && process.platform === 'linux' && process.env.SNAP) {
        console.log('common path', getLinuxPath(app))
        return getLinuxPath(app);
    }

    if (old && process.platform === 'linux' && process.env.SNAP) {
        const oldPath = path.join(electronApp.getPath('home'), 'snap', 'taisho', 'current', '.config', 'taisho');
        console.log('old path', oldPath)
        pierPath = await fs.realpath(oldPath);
        console.log('old path expanded', pierPath)
    }

    if (suffix) {
        pierPath = path.join(pierPath, suffix)
    }

    return pierPath;
}

export async function portDBMigration(): Promise<void> {
    console.log('Attempting Port DB migration...')

    const oldDbPath = await getMigrationPath('db');
    const dbPath = await getMigrationPath('db', false)

    console.log({ oldDbPath, dbPath })

    if (!(await fs.pathExists(oldDbPath))) {
        console.log('Taisho DB not found, migration unnecessary')
        return;
    }

    if (await fs.pathExists(dbPath)) {
        console.log('Port DB migration unnecessary')
        return;
    }
    
    console.log('Port DB not found, migrating')
    await fs.copy(oldDbPath, dbPath)
    console.log('Port DB migrated')
}

export async function portPierMigration(ps: PierService): Promise<void> {
    console.log('Attempting Port Pier migration...')

    const oldPierPath = await getMigrationPath('piers', true, true);
    const pierPath = await getMigrationPath('piers', false, true);
    const piers: Pier[] = await ps.getPiers()
    const piersToMigrate = piers.filter(pier => pier.directory.startsWith(oldPierPath));

    if (piersToMigrate.length === 0 || process.platform === 'linux' && process.env.SNAP) {
        console.log('Port pier migration unnecessary')
        send('piers-migrated');
        ps.migrationStatus = 'migrated';
        return;
    }

    try {
        await each(piersToMigrate, async pier => {
            await ps.stopPier(pier)
            await ps.updatePier({ ...pier, directory: pierPath })
        });
    
        await fs.copy(oldPierPath, pierPath)
    } catch (err) {
        console.error(err);
    }

    let count = piersToMigrate.length;
    await whilst(cb => cb(null, count > 0), async (iterate: any) => {
        await each(piersToMigrate, async pier => {
            if (await fs.pathExists(path.join(pierPath, pier.slug))) {
                count--;
                iterate(null, count);
            }
        })
    });

    send('piers-migrated');
    ps.migrationStatus = 'migrated';
}