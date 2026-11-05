/**
 * The web shell's JSON replies: every API answer and every refusal the route
 * sends is one of these two helpers.
 */

import type { ServerResponse } from 'node:http';

// Serialized before the head is written, so a result JSON cannot encode still
// gets a proper error response.
const sendJson = (res: ServerResponse, status: number, body: object) => {
    const json = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(json);
};

// An absent message is fine: the bridge then reports the status code.
const fail = (res: ServerResponse, status: number, error: string | undefined) =>
    sendJson(res, status, { success: false, error });

export { sendJson, fail };
