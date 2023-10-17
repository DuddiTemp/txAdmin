const modulename = 'WebServer';
import crypto from 'node:crypto';
import path from 'node:path';
import HttpClass from 'node:http';

import Koa from 'koa';
import KoaBodyParser from 'koa-bodyparser';
//@ts-ignore
import KoaServe from 'koa-static';
//@ts-ignore
import KoaSession from 'koa-session';
import KoaSessionMemoryStoreClass from 'koa-session-memory';
import KoaCors from '@koa/cors';

import { Server as SocketIO } from 'socket.io';
//@ts-ignore
import SessionIO from 'koa-session-socketio';
import WebSocket from './webSocket';

import { customAlphabet } from 'nanoid';
import dict51 from 'nanoid-dictionary/nolookalikes';

import { convars, txEnv } from '@core/globalData';
import router from './router';
import consoleFactory from '@extras/console';
import TxAdmin from '@core/txAdmin';
import topLevelMw from './middlewares/topLevelMw';
import setupVarsMw from './middlewares/setupVarsMw';
import setupUtilsMw from './middlewares/setupUtilsMw.js';
const console = consoleFactory(modulename);
const nanoid = customAlphabet(dict51, 20);

//Types
export type WebServerConfigType = {
    disableNuiSourceCheck: boolean;
    limiterMinutes: number;
    limiterAttempts: number;
}

export default class WebServer {
    readonly #txAdmin: TxAdmin;
    public isListening = false;
    private httpRequestsCounter = 0;
    private koaSessionKey: string;
    public luaComToken: string;
    //setupKoa
    private app: Koa;
    private koaSessionMemoryStore: typeof KoaSessionMemoryStoreClass;
    private sessionInstance: typeof KoaSession;
    private koaCallback: (req: any, res: any) => Promise<void>;
    //setupWebSocket
    private io: SocketIO;
    private webSocket: WebSocket;
    //setupServerCallbacks
    private httpServer?: HttpClass.Server;

    constructor(txAdmin: TxAdmin, public config: WebServerConfigType) {
        this.#txAdmin = txAdmin;

        //Counting requests per minute
        setInterval(() => {
            if (this.httpRequestsCounter > 10_000) {
                const numberFormatter = new Intl.NumberFormat('en-US');
                console.majorMultilineError([
                    'txAdmin might be under a DDoS attack!',
                    `We detected ${numberFormatter.format(this.httpRequestsCounter)} HTTP requests in the last minute.`,
                    'Make sure you have a proper firewall setup and/or a reverse proxy with rate limiting.',
                ]);
            }
            this.httpRequestsCounter = 0;
        }, 60_000);

        //Generate cookie key & luaComToken
        const pathHash = crypto.createHash('shake256', { outputLength: 6 })
            .update(txAdmin.info.serverProfilePath)
            .digest('hex');
        this.koaSessionKey = `tx:${txAdmin.info.serverProfile}:${pathHash}`;
        this.luaComToken = nanoid();


        // ===================
        // Setting up Koa
        // ===================
        this.app = new Koa();
        this.app.keys = ['txAdmin' + nanoid()];

        // Some people might want to enable it, but we are not guaranteeing XFF security
        // due to the many possible ways you can connect to koa.
        // this.app.proxy = true;

        //Session
        this.koaSessionMemoryStore = new KoaSessionMemoryStoreClass();
        this.sessionInstance = KoaSession({
            store: this.koaSessionMemoryStore,
            key: this.koaSessionKey,
            rolling: true,
            maxAge: 24 * 60 * 60 * 1000, //one day
        }, this.app);

        //Setting up app
        this.app.on('error', (error, ctx) => {
            if (!(
                error.code?.startsWith('HPE_')
                || error.code?.startsWith('ECONN')
                || error.code === 'EPIPE'
                || error.code === 'ECANCELED'
            )) {
                console.error(`Probably harmless error on ${ctx.path}`);
                console.error('Please be kind and send a screenshot of this error to the txAdmin developer.');
                console.dir(error);
            }
        });

        //Disable CORS on dev mode
        if (convars.isDevMode) {
            this.app.use(KoaCors());
        }

        //Setting up timeout/error/no-output/413
        this.app.use(topLevelMw);

        //Setting up additional middlewares:
        const jsonLimit = '16MB';
        const panelPublicPath = convars.isDevMode
            ? path.join(process.env.TXADMIN_DEV_SRC_PATH as string, 'panel/public')
            : path.join(txEnv.txAdminResourcePath, 'panel');
        this.app.use(KoaServe(path.join(txEnv.txAdminResourcePath, 'web/public'), { index: false, defer: false }));
        this.app.use(KoaServe(panelPublicPath, { index: false, defer: false }));
        this.app.use(this.sessionInstance);
        this.app.use(KoaBodyParser({ jsonLimit }));

        //Custom stuff
        this.app.use(setupVarsMw(txAdmin));
        this.app.use(setupUtilsMw);

        //Setting up routes
        const txRouter = router(this.config);
        this.app.use(txRouter.routes());
        this.app.use(txRouter.allowedMethods());
        this.app.use(async (ctx) => {
            if (typeof ctx._matchedRoute === 'undefined') {
                if (ctx.path.startsWith('/legacy')) {
                    ctx.status = 404;
                    console.verbose.warn(`Request 404 error: ${ctx.path}`);
                    return ctx.utils.render('standalone/404');
                } else {
                    return ctx.utils.serveReactIndex();
                }
            }
        });
        this.koaCallback = this.app.callback();


        // ===================
        // Setting up SocketIO
        // ===================
        this.io = new SocketIO(HttpClass.createServer(), { serveClient: false });
        this.io.use(SessionIO(this.koaSessionKey, this.koaSessionMemoryStore));
        this.webSocket = new WebSocket(this.#txAdmin, this.io);
        //@ts-ignore
        this.io.on('connection', this.webSocket.handleConnection.bind(this.webSocket));


        // ===================
        // Setting up Callbacks
        // ===================
        this.setupServerCallbacks();
    }


    /**
     * Handler for all HTTP requests
     */
    httpCallbackHandler(req: Request, res: Response) {
        //Calls the appropriate callback
        try {
            this.httpRequestsCounter++;
            if (req.url.startsWith('/socket.io')) {
                //@ts-ignore
                this.io.engine.handleRequest(req, res);
            } else {
                //@ts-ignore
                this.koaCallback(req, res);
            }
        } catch (error) { }
    }


    /**
     * Setup the HTTP server callbacks
     */
    setupServerCallbacks() {
        //Just in case i want to re-execute this function
        this.isListening = false;

        //HTTP Server
        try {
            const listenErrorHandler = (error: any) => {
                if (error.code !== 'EADDRINUSE') return;
                console.error(`Failed to start HTTP server, port ${error.port} is already in use.`);
                console.error('Maybe you already have another txAdmin running in this port.');
                console.error('If you want to run multiple txAdmin instances, check the documentation for the port convar.');
                console.error('You can also try restarting the host machine.');
                process.exit(5800);
            };
            //@ts-ignore
            this.httpServer = HttpClass.createServer(this.httpCallbackHandler.bind(this));
            this.httpServer.on('error', listenErrorHandler);

            let iface: string;
            if (convars.forceInterface) {
                console.warn(`Starting with interface ${convars.forceInterface}.`);
                console.warn('If the HTTP server doesn\'t start, this is probably the reason.');
                iface = convars.forceInterface;
            } else {
                iface = '0.0.0.0';
            }

            this.httpServer.listen(convars.txAdminPort, iface, async () => {
                console.ok(`Listening on ${iface}.`);
                this.isListening = true;
            });
        } catch (error) {
            console.error('Failed to start HTTP server with error:');
            console.dir(error);
            process.exit(5801);
        }
    }


    /**
     * Resetting lua comms token - called by fxRunner on spawnServer()
     */
    resetToken() {
        this.luaComToken = nanoid();
        console.verbose.log('Resetting luaComToken.');
    }
};