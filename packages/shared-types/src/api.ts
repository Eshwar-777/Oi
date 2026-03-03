export interface IApiResponse<T> {
  data: T;
  status: "ok" | "error";
}

export interface IApiError {
  status: "error";
  detail: string;
  code?: string;
}

export interface IPaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  per_page: number;
  has_next: boolean;
}
