import type {
  AdminOverview,
  AttendanceEntryDto,
  AttendanceHistoryQuery,
  AttendanceRecordDto,
  AttendanceReportQuery,
  AttendanceStatusDto,
  AuthUser,
  AvatarSummary,
  ChangePasswordRequest,
  CreateAttendanceEntryRequest,
  CreateSiteRequest,
  CreateUserRequest,
  ExportQuery,
  ListAttendanceEntriesQuery,
  ListUsersQuery,
  LoginRequest,
  LoginResponse,
  OrganizationDto,
  Paginated,
  ProfileDto,
  PunchRequest,
  PunchResponse,
  ReportRow,
  ReportSummary,
  SiteDto,
  UpdateAttendanceEntryRequest,
  UpdateOrganizationRequest,
  UpdateProfileRequest,
  UpdateSiteRequest,
  UpdateUserRequest,
  UserDto,
} from '@wasel/contracts';
import { apiClient } from './client';
import { endpoints } from './endpoints';
import type { BinaryResponse, QueryParams } from './http';

/**
 * Typed bindings to the API. Every argument and return type comes from
 * `@wasel/contracts`; nothing here redeclares a shape.
 *
 * Each call takes an optional `AbortSignal` so TanStack Query can cancel a
 * superseded request — a search-as-you-type on the users list otherwise races
 * its own responses and can land an older page last.
 */

export const authApi = {
  login: (body: LoginRequest, signal?: AbortSignal) =>
    apiClient.request<LoginResponse>(endpoints.auth.login, {
      method: 'POST',
      body,
      auth: false,
      signal,
    }),

  /** Best-effort: a failure here still ends the local session. */
  logout: (refreshToken: string | null) =>
    apiClient.request<void>(endpoints.auth.logout, {
      method: 'POST',
      body: refreshToken ? { refreshToken } : {},
    }),

  me: (signal?: AbortSignal) => apiClient.request<AuthUser>(endpoints.auth.me, { signal }),

  changePassword: (body: ChangePasswordRequest) =>
    apiClient.request<void>(endpoints.auth.changePassword, { method: 'POST', body }),
};

export const profileApi = {
  get: (signal?: AbortSignal) => apiClient.request<ProfileDto>(endpoints.profile.self, { signal }),

  /**
   * Changing `email` also requires `currentPassword`, and revokes every session
   * including this one — the caller must sign out afterwards. Changing only
   * `fullName` does neither.
   */
  update: (body: UpdateProfileRequest) =>
    apiClient.request<ProfileDto>(endpoints.profile.self, { method: 'PATCH', body }),

  /**
   * Uploads the picture as the raw request body.
   *
   * The `Content-Type` is set explicitly rather than left to the `Blob`: the
   * server checks the declared type against the file's magic bytes and refuses a
   * mismatch, so an empty or guessed type is a rejected upload.
   */
  uploadAvatar: (image: Blob, contentType: string) =>
    apiClient.request<AvatarSummary>(endpoints.profile.avatar, {
      method: 'PUT',
      body: image,
      headers: { 'Content-Type': contentType },
    }),

  removeAvatar: () => apiClient.request<void>(endpoints.profile.avatar, { method: 'DELETE' }),

  /**
   * A user's picture, as bytes.
   *
   * Goes through the API client rather than an `<img src>` because the route is
   * authenticated: an `<img>` cannot carry a bearer token, and pointing one at
   * this URL would produce a 401 rendered as a broken image.
   */
  avatarBlob: (userId: string, signal?: AbortSignal): Promise<BinaryResponse> =>
    apiClient.requestBinary(endpoints.profile.userAvatar(userId), { signal }),
};

export const attendanceApi = {
  status: (signal?: AbortSignal) =>
    apiClient.request<AttendanceStatusDto>(endpoints.attendance.status, { signal }),

  checkIn: (body: PunchRequest) =>
    apiClient.request<PunchResponse>(endpoints.attendance.checkIn, { method: 'POST', body }),

  checkOut: (body: PunchRequest) =>
    apiClient.request<PunchResponse>(endpoints.attendance.checkOut, { method: 'POST', body }),

  history: (query: Partial<AttendanceHistoryQuery>, signal?: AbortSignal) =>
    apiClient.request<Paginated<AttendanceRecordDto>>(endpoints.attendance.history, {
      query: query as QueryParams,
      signal,
    }),
};

export interface AttendanceReport extends Paginated<ReportRow> {
  summary: ReportSummary;
}

export const adminApi = {
  overview: (signal?: AbortSignal) =>
    apiClient.request<AdminOverview>(endpoints.admin.overview, { signal }),

  listUsers: (query: Partial<ListUsersQuery>, signal?: AbortSignal) =>
    apiClient.request<Paginated<UserDto>>(endpoints.admin.users, {
      query: query as QueryParams,
      signal,
    }),

  createUser: (body: CreateUserRequest) =>
    apiClient.request<UserDto>(endpoints.admin.users, { method: 'POST', body }),

  updateUser: (id: string, body: UpdateUserRequest) =>
    apiClient.request<UserDto>(endpoints.admin.user(id), { method: 'PATCH', body }),

  /**
   * A soft delete: the row and every attendance record referencing it survive,
   * the person leaves the directory, and their sessions are revoked. Refused
   * with 422 `LAST_ADMIN` when it would leave the organization without an admin.
   */
  deleteUser: (id: string) =>
    apiClient.request<void>(endpoints.admin.user(id), { method: 'DELETE' }),

  resetUserPassword: (id: string, newPassword: string) =>
    apiClient.request<void>(endpoints.admin.userPassword(id), {
      method: 'POST',
      body: { newPassword },
    }),

  listSites: (signal?: AbortSignal) =>
    apiClient.request<Paginated<SiteDto>>(endpoints.admin.sites, { signal }),

  createSite: (body: CreateSiteRequest) =>
    apiClient.request<SiteDto>(endpoints.admin.sites, { method: 'POST', body }),

  updateSite: (id: string, body: UpdateSiteRequest) =>
    apiClient.request<SiteDto>(endpoints.admin.site(id), { method: 'PATCH', body }),

  deleteSite: (id: string) =>
    apiClient.request<void>(endpoints.admin.site(id), { method: 'DELETE' }),

  organization: (signal?: AbortSignal) =>
    apiClient.request<OrganizationDto>(endpoints.admin.organization, { signal }),

  updateOrganization: (body: UpdateOrganizationRequest) =>
    apiClient.request<OrganizationDto>(endpoints.admin.organization, { method: 'PATCH', body }),

  /**
   * Attendance in a date range, every row carrying how it came to exist.
   *
   * Distinct from {@link adminApi.report}: that endpoint answers "what did this
   * month look like", this one answers "which of these days did a human type
   * in, and who". Filter with `source: 'MANUAL'` for the second question alone.
   */
  listAttendanceEntries: (query: Partial<ListAttendanceEntriesQuery>, signal?: AbortSignal) =>
    apiClient.request<Paginated<AttendanceEntryDto>>(endpoints.admin.attendanceEntries, {
      query: query as QueryParams,
      signal,
    }),

  /** Times are local wall clocks in the organization timezone; the server resolves them. */
  createAttendanceEntry: (body: CreateAttendanceEntryRequest) =>
    apiClient.request<AttendanceEntryDto>(endpoints.admin.attendanceEntries, {
      method: 'POST',
      body,
    }),

  /** Flips the record to `MANUAL` and stamps the caller on it, punched or not. */
  updateAttendanceEntry: (id: string, body: UpdateAttendanceEntryRequest) =>
    apiClient.request<AttendanceEntryDto>(endpoints.admin.attendanceEntry(id), {
      method: 'PATCH',
      body,
    }),

  deleteAttendanceEntry: (id: string) =>
    apiClient.request<void>(endpoints.admin.attendanceEntry(id), { method: 'DELETE' }),

  report: (query: Partial<AttendanceReportQuery>, signal?: AbortSignal) =>
    apiClient.request<AttendanceReport>(endpoints.admin.report, {
      query: query as QueryParams,
      signal,
    }),

  /**
   * The attendance sheet. Returns the raw bytes plus the server's filename so
   * the caller can hand it to `@capacitor/filesystem` on device or an object
   * URL in the browser. Exports are generated on the fly and can take a while,
   * hence the extended deadline.
   */
  exportAttendance: (query: ExportQuery, signal?: AbortSignal): Promise<BinaryResponse> =>
    apiClient.requestBinary(endpoints.admin.export, {
      query: query as unknown as QueryParams,
      signal,
      timeoutMs: 60_000,
    }),
};
