let currentAccessToken = "";

export function setCurrentAccessToken(token: string) {
  currentAccessToken = token;
}

export async function getCurrentAccessToken(): Promise<string> {
  return currentAccessToken;
}
