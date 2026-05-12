/**
 * Cloud-routes request schemas.
 *
 * TypeBox schemas auto-validate the request body via the route
 * middleware in openapi-registry. Missing fields, wrong types, and
 * empty strings are rejected with 400 before the handler runs.
 */

import { Type, type Static } from '@sinclair/typebox';

/** Schema for POST /api/cloud/smb/connect. */
export const smbConnectSchema = Type.Object(
  {
    host: Type.String({
      minLength: 1,
      maxLength: 255,
      description: 'SMB host (FQDN, mDNS .local name, or IP address)',
      examples: ['synology.local', '192.168.1.50'],
    }),
    share: Type.String({
      minLength: 1,
      maxLength: 255,
      description: 'Share name (no leading slash)',
      examples: ['backups'],
    }),
    user: Type.String({
      minLength: 1,
      maxLength: 255,
      description: 'SMB username',
    }),
    password: Type.String({
      minLength: 1,
      description: 'SMB password — stored in rclone.conf in clear text',
    }),
    domain: Type.Optional(
      Type.String({
        maxLength: 255,
        description: 'NetBIOS / NTLM domain (optional, defaults to WORKGROUP)',
      })
    ),
  },
  { additionalProperties: false, $id: 'SmbConnectBody' }
);

export type SmbConnectBody = Static<typeof smbConnectSchema>;
