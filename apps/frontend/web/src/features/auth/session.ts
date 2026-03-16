let currentAccessToken = "";
let currentCsrfToken = "";

export function setCurrentAccessToken(token: string) {
  currentAccessToken = token;
}

export async function getCurrentAccessToken(): Promise<string> {
  return currentAccessToken;
}

export function setCurrentCsrfToken(token: string) {
  currentCsrfToken = token;
}

export async function getCurrentCsrfToken(): Promise<string> {
  return currentCsrfToken;
}
