/**
 * Firestore real-time listener helpers.
 *
 * These are thin wrappers -- the actual Firestore SDK is injected by the app
 * (web uses firebase/firestore, mobile uses @react-native-firebase/firestore).
 * This module provides the listener setup pattern without coupling to a
 * specific SDK.
 */

import type { ITaskState, ITaskEvent } from "@oi/shared-types";

export interface IFirestoreAdapter {
  onSnapshot<T>(
    collectionPath: string,
    documentId: string,
    callback: (data: T | null) => void,
  ): () => void;

  onCollectionSnapshot<T>(
    collectionPath: string,
    query: Record<string, unknown>,
    callback: (items: T[]) => void,
  ): () => void;
}

export function createTaskListener(
  firestore: IFirestoreAdapter,
  taskId: string,
  onUpdate: (task: ITaskState | null) => void,
): () => void {
  return firestore.onSnapshot<ITaskState>("tasks", taskId, onUpdate);
}

export function createTaskEventsListener(
  firestore: IFirestoreAdapter,
  taskId: string,
  onEvents: (events: ITaskEvent[]) => void,
): () => void {
  return firestore.onCollectionSnapshot<ITaskEvent>(
    `tasks/${taskId}/events`,
    {},
    onEvents,
  );
}

export function createMeshListener(
  firestore: IFirestoreAdapter,
  userId: string,
  onUpdate: (tasks: ITaskState[]) => void,
): () => void {
  return firestore.onCollectionSnapshot<ITaskState>("tasks", { user_id: userId }, onUpdate);
}
