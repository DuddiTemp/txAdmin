const modulename = 'PlayerDatabase';
import { Database } from './database';
import consoleFactory from '@lib/console';

import PlayersDao from './dao/players';
import ActionsDao from './dao/actions';
import WhitelistDao from './dao/whitelist';
import StatsDao from './dao/stats';
import CleanupDao from './dao/cleanup';
const console = consoleFactory(modulename);


//Types
export type PlayerDbConfigType = {
    onJoinCheckBan: boolean;
    whitelistMode: 'disabled' | 'adminOnly' | 'guildMember' | 'guildRoles' | 'approvedLicense';
    whitelistedDiscordRoles: string[];
    whitelistRejectionMessage: string;
    requiredBanHwidMatches: number;
    banRejectionMessage: string;
}


/**
 * Provide a central database for players, as well as assist with access control.
 */
export default class PlayerDatabase {
    public config: PlayerDbConfigType;
    readonly #db: Database;

    //Database Methods
    readonly players: PlayersDao;
    readonly actions: ActionsDao;
    readonly whitelist: WhitelistDao;
    readonly stats: StatsDao;
    readonly cleanup: CleanupDao;

    constructor() {
        this.config = txConfig.playerDatabase;
        //Checking config validity
        if (this.config.requiredBanHwidMatches < 0 || this.config.requiredBanHwidMatches > 6) {
            throw new Error('The playerDatabase.requiredBanHwidMatches setting must be between 0 (disabled) and 6.');
        }

        this.#db = new Database();
        this.players = new PlayersDao(this.#db);
        this.actions = new ActionsDao(this.#db);
        this.whitelist = new WhitelistDao(this.#db);
        this.stats = new StatsDao(this.#db);
        this.cleanup = new CleanupDao(this.#db);

        //Database optimization cron function
        setTimeout(() => {
            this.cleanup.runDailyOptimizer();
        }, 30_000);
        setInterval(() => {
            this.cleanup.runDailyOptimizer();
        }, 24 * 60 * 60_000);
    }


    /**
     * Returns if the lowdb instance is ready
     */
    get isReady() {
        return this.#db.isReady;
    }

    /**
     * Refresh configurations
     */
    refreshConfig() {
        this.config = txCore.configVault.getScoped('playerDatabase');
    }

    /**
     * Returns the entire lowdb object. Please be careful with it :)
     */
    getDboRef() {
        if (!this.#db.obj) throw new Error(`database not ready yet`);
        return this.#db.obj;
    }
};
