import React from 'react';
import {render} from 'ink';
import {App} from './App.js';
import type {ResidentSnapshot} from './domain.js';
import {SocketResidentSession} from './resident-client.js';
import type {MatterWorkspace} from './workspace.js';
import {startResident} from './runtime/daemon-control.js';

export async function openResidentSession(workspace: MatterWorkspace, plain = false): Promise<void> {
  let session: SocketResidentSession | null = null;
  try {
    session = await SocketResidentSession.connect();
    const live = await session.snapshot();
    if (live.agent.name !== workspace.agentName) {
      await session.detach();
      session = null;
      throw new Error(`matterd is serving ${live.agent.name}, not ${workspace.agentName}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('matterd is serving')) throw error;
    session = null;
  }

  if (!session) {
    await startResident(workspace.root);
    session = await SocketResidentSession.connect(undefined, 2_000);
  }
  const snapshot: ResidentSnapshot = await session.snapshot();

  render(
    <App
      initialSnapshot={snapshot}
      session={session}
      interactive={!plain}
      colorEnabled={!plain && process.env.NO_COLOR === undefined}
    />,
    {exitOnCtrlC: false, patchConsole: false},
  );
}
