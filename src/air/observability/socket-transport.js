'use strict';

const net = require('node:net');
const path = require('node:path');

class ObservationSocketTransport {
  constructor({
    socketPath,
    maxQueue = 1024,
    reconnectScheduleMs = [50, 100, 250, 500, 1_000],
    ackTimeoutMs = 1_000,
    connectionFactory = (options) => net.createConnection(options),
  }) {
    if (!path.isAbsolute(socketPath)) throw new TypeError('observation_socket_path_invalid');
    if (!Number.isInteger(maxQueue) || maxQueue < 1 || maxQueue > 100_000) {
      throw new TypeError('observation_queue_limit_invalid');
    }
    this.socketPath = socketPath;
    this.maxQueue = maxQueue;
    this.reconnectScheduleMs = Object.freeze([...reconnectScheduleMs]);
    this.ackTimeoutMs = ackTimeoutMs;
    this.connectionFactory = connectionFactory;
    this.queue = [];
    this.socket = null;
    this.ackBuffer = '';
    this.reconnectTimer = null;
    this.ackTimer = null;
    this.reconnectIndex = 0;
    this.started = false;
    this.connected = false;
    this.inFlight = false;
    this.exportedCount = 0;
    this.droppedCount = 0;
    this.connectFailureCount = 0;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  enqueue(event) {
    try {
      if (this.queue.length >= this.maxQueue) {
        this.droppedCount += 1;
        return false;
      }
      this.queue.push(`${JSON.stringify(event)}\n`);
      if (this.started && this.connected) this.sendNext();
      else if (this.started && !this.socket && !this.reconnectTimer) this.connect();
      return true;
    } catch {
      this.droppedCount += 1;
      return false;
    }
  }

  snapshot() {
    return Object.freeze({
      started: this.started,
      connected: this.connected,
      queued: this.queue.length,
      in_flight: this.inFlight,
      exported_count: this.exportedCount,
      dropped_count: this.droppedCount,
      connect_failure_count: this.connectFailureCount,
    });
  }

  async flush({ timeoutMs = 250 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (this.connected && (this.queue.length > 0 || this.inFlight)) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return this.queue.length === 0 && !this.inFlight;
  }

  async close() {
    await this.flush().catch(() => false);
    this.started = false;
    this.connected = false;
    this.inFlight = false;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.ackTimer);
    this.reconnectTimer = null;
    this.ackTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.destroy();
  }

  connect() {
    if (!this.started || this.socket) return;
    let socket;
    try {
      socket = this.connectionFactory({ path: this.socketPath });
    } catch {
      this.connectFailureCount += 1;
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.setNoDelay?.(true);
    socket.on('connect', () => {
      if (socket !== this.socket) return;
      this.connected = true;
      this.reconnectIndex = 0;
      this.sendNext();
    });
    socket.on('data', (chunk) => this.handleAcknowledgementBytes(socket, chunk));
    socket.on('error', () => {
      if (socket === this.socket) this.connectFailureCount += 1;
    });
    socket.on('close', () => {
      if (socket !== this.socket) return;
      this.socket = null;
      this.connected = false;
      this.inFlight = false;
      this.ackBuffer = '';
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (!this.started || this.reconnectTimer || this.queue.length === 0) return;
    const delay = this.reconnectScheduleMs[
      Math.min(this.reconnectIndex, this.reconnectScheduleMs.length - 1)
    ];
    this.reconnectIndex += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  sendNext() {
    if (!this.started || !this.connected || this.inFlight || this.queue.length === 0) return;
    this.inFlight = true;
    try {
      this.socket.write(this.queue[0]);
    } catch {
      this.disconnectForReplay();
      return;
    }
    this.ackTimer = setTimeout(() => this.disconnectForReplay(), this.ackTimeoutMs);
  }

  handleAcknowledgementBytes(socket, chunk) {
    if (socket !== this.socket) return;
    this.ackBuffer += chunk.toString('utf8');
    while (true) {
      const newline = this.ackBuffer.indexOf('\n');
      if (newline < 0) return;
      const frame = this.ackBuffer.slice(0, newline);
      this.ackBuffer = this.ackBuffer.slice(newline + 1);
      this.handleAcknowledgement(frame);
    }
  }

  handleAcknowledgement(frame) {
    let value;
    try {
      value = JSON.parse(frame);
    } catch {
      this.disconnectForReplay();
      return;
    }
    if (!validAcknowledgement(value)) {
      this.disconnectForReplay();
      return;
    }
    clearTimeout(this.ackTimer);
    this.ackTimer = null;
    this.inFlight = false;
    this.queue.shift();
    if (value.accepted) this.exportedCount += 1;
    else this.droppedCount += 1;
    this.sendNext();
  }

  disconnectForReplay() {
    clearTimeout(this.ackTimer);
    this.ackTimer = null;
    this.inFlight = false;
    this.socket?.destroy();
  }
}

function validAcknowledgement(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort().join(',');
  return keys === 'accepted,category,duplicate,schema_version'
    && value.schema_version === 'wechat.qa.observation.ack.v1'
    && typeof value.accepted === 'boolean'
    && typeof value.duplicate === 'boolean'
    && typeof value.category === 'string'
    && value.category.length > 0
    && value.category.length <= 64;
}

module.exports = { ObservationSocketTransport };
