import HTTP from 'http';
import { Duplex } from 'stream';

import Request from "../Request.js";
import Response from "../Response.js";
import Websocket from "../websocket/ws.js";
import LoggerManager from "../LoggerManager.js";

import type Router from "./Router.js";
import Tracker from "./Tracker.js";
import ServerError from '../ServerError.js';

export class Gate {
    private readonly logger: LoggerManager = LoggerManager.getInstance();
    private proxy: boolean = false;

    public constructor(
        private readonly router: Router,
        options: Gate.Options = {}
    ) {
        this.proxy = options.proxy ?? false;
        this.logger = options.logger ?? LoggerManager.getInstance();
    }

    public async requestManager(HttpRequest: HTTP.IncomingMessage, HttpResponse: HTTP.ServerResponse): Promise<void> {
        const request = new Request(HttpRequest, {
            allowForwardedIP: this.proxy,
        });
        const response = new Response(HttpResponse);
        const tracker = new Tracker(request, response);
        this.logger.request.log(request.ip, request.method, request.url);
        try {
            const routed = await this.router.route(request, response, {}, tracker);
            if (!routed && !response.isSent) await response.status(404).send(`No route for: ${request.method} -> ${request.url}`);
            if (response.isSent) tracker.markSent();
            tracker.complete();
        } catch (caught) {
            tracker.fail(caught);
            const error = caught instanceof ServerError ? caught : new ServerError(500, `Internal Server Error: "${caught instanceof Error ? caught.message : String(caught)}"`);
            if (response.isSent) return void this.logger.error(error);
            await response.status(error.status).send(error.message);
        }
    }

    public async upgradeManager(HttpRequest: HTTP.IncomingMessage, Socket: Duplex): Promise<void> {
        const request = new Request(HttpRequest);
        const websocket = new Websocket.Server(request, Socket);
        const tracker = new Tracker(request, websocket);
        this.logger.webSocket.log(request.ip, request.method, request.url);
        try {
            const routed = await this.router.route(request, websocket, {}, tracker);
            if (!routed) websocket.reject(404, `No route for: ${request.method} -> ${request.url}`).catch(() => { });
            tracker.complete();
        } catch (caught) {
            tracker.fail(caught);
            const error = caught instanceof ServerError ? caught : new ServerError(500, `Internal Server Error: "${caught instanceof Error ? caught.message : String(caught)}"`);
            if (websocket.isClosed) return void this.logger.error(error);
            if (websocket.status !== 'handshake') return;
            await websocket.reject(error.status, error.message);
        }
    }
}

export namespace Gate {
    export interface Options {
        proxy?: boolean;
        logger?: LoggerManager;
    }
}

export default Gate;