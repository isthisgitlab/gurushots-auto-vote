// @ts-check
/** @param {number} n */
const pad = (n) => String(n).padStart(2, '0');

/** @param {Date} [d] */
const formatTimeHMS = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

/** @param {Date} [d] */
const formatDateTime = (d = new Date()) =>
    `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${formatTimeHMS(d)}`;

export { formatTimeHMS, formatDateTime };
