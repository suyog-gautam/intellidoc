'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DocumentSession, OpenProgress } from '@/lib/session/documentSession';
import type { ReconstructionClient } from '@/lib/workers/reconstructionClient';
import { StartScreen } from './start/StartScreen';

/*
 * Load strategy: the start screen is all the first page load ships. The
 * editor UI, the document session (OCR, PDF), and the processing worker are
 * loaded on demand, and prefetched as soon as the user shows intent
 * (hovering / focusing the upload card, dragging a file over the page).
 */
const loadEditor = () => import('./editor/Editor');
const Editor = dynamic(() => loadEditor().then((m) => m.Editor), { ssr: false });
const loadSession = () => import('@/lib/session/documentSession');
const loadClient = () => import('@/lib/workers/reconstructionClient');

function userMessage(e: unknown): string {
  const msg = (e as { userMessage?: unknown } | undefined)?.userMessage;
  return typeof msg === 'string' ? msg : 'Something went wrong while processing this document. Please try again.';
}

export function IntelliDocApp() {
  const clientRef = useRef<ReconstructionClient | undefined>(undefined);
  const [session, setSession] = useState<DocumentSession>();
  const [progress, setProgress] = useState<OpenProgress>();
  const [error, setError] = useState<string>();

  useEffect(() => () => clientRef.current?.dispose(), []);

  const prefetch = useCallback(() => {
    void loadEditor();
    void loadSession();
    void loadClient();
  }, []);

  const onFile = async (file: File) => {
    setError(undefined);
    setProgress({ stage: 'validating' });
    try {
      const [{ DocumentSession }, { ReconstructionClient }] = await Promise.all([loadSession(), loadClient(), loadEditor()]);
      // The worker is created on first use, not on page load.
      clientRef.current ??= new ReconstructionClient();
      setSession(await DocumentSession.open(file, clientRef.current, setProgress));
    } catch (e) {
      setError(userMessage(e));
      console.error(e);
    } finally {
      setProgress(undefined);
    }
  };

  const close = () => {
    void session?.dispose();
    // A fresh worker drops all page rasters of the previous document.
    clientRef.current?.dispose();
    clientRef.current = undefined;
    setSession(undefined);
  };

  if (session && clientRef.current) return <Editor key={session.initial.id} client={clientRef.current} session={session} onClose={close} />;
  return <StartScreen onFile={onFile} onIntent={prefetch} progress={progress} error={error} />;
}
