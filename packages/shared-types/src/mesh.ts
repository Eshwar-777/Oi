export type DeviceType = "web" | "mobile" | "desktop" | "extension";

export type MeshRole = "owner" | "delegate";

export interface IDevice {
  device_id: string;
  user_id: string;
  device_type: DeviceType;
  device_name: string;
  fcm_token: string | null;
  is_online: boolean;
  last_seen: string;
}

export interface IMeshMember {
  user_id: string;
  role: MeshRole;
  display_name: string;
  added_at: string;
}

export interface IMeshGroup {
  group_id: string;
  owner_user_id: string;
  name: string;
  members: IMeshMember[];
}

export interface IDeviceRegistration {
  device_type: DeviceType;
  device_name: string;
  fcm_token?: string;
}
