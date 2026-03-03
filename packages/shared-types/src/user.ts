export interface IUser {
  user_id: string;
  email: string;
  display_name: string;
  created_at: string;
}

export interface IAuthToken {
  token: string;
  user_id: string;
  expires_at: string;
}
