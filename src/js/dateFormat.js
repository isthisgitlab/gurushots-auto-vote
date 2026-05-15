const pad = (n) => String(n).padStart(2, '0');

const formatTimeHMS = (d = new Date()) =>
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

const formatDateTime = (d = new Date()) =>
    `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${formatTimeHMS(d)}`;

module.exports = { formatTimeHMS, formatDateTime };
