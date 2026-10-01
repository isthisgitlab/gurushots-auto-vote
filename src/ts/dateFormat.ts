/** @param n */
const pad = (n: number) => String(n).padStart(2, '0');

/** @param d */
const formatTimeHMS = (d: Date = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

/** @param d */
const formatDateTime = (d: Date = new Date()) =>
    `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${formatTimeHMS(d)}`;

export { formatTimeHMS, formatDateTime };
