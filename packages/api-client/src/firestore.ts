/**
 * Firestore real-time listener helpers.
 *
 * These are thin wrappers -- the actual Firestore SDK is injected by the app
 * (web uses firebase/firestore, mobile uses @react-native-firebase/firestore).
 * This module provides the listener setup pattern without coupling to a
 * specific SDK.
 */

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

export function createDocumentListener<T>(
  firestore: IFirestoreAdapter,
  collection: string,
  documentId: string,
  onUpdate: (data: T | null) => void,
): () => void {
  return firestore.onSnapshot<T>(collection, documentId, onUpdate);
}

export function createCollectionListener<T>(
  firestore: IFirestoreAdapter,
  collection: string,
  query: Record<string, unknown>,
  onUpdate: (items: T[]) => void,
): () => void {
  return firestore.onCollectionSnapshot<T>(collection, query, onUpdate);
}
