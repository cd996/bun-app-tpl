# Policy Module

The policy module implements Zanzibar-style relation tuples for authorization checks and permission inspection.

Code layout:

```text
apps/api/src/modules/policy/
  namespace-config.ts
  policy.routes.ts
  policy.service.ts
  resource-group.service.ts
  zanzibar.engine.ts
```

## Tuple Model

A tuple grants a relation on an object to a subject:

```text
namespace:objectId#relation@subjectNamespace:subjectId
namespace:objectId#relation@subjectNamespace:subjectId#subjectRelation
```

Examples:

```text
document:doc123#viewer@user:user123
document:doc123#editor@group:group123#member
group:group123#member@user:user123
```

## Routes

All policy routes require admin access.

| Method | Path | Description |
|---|---|---|
| GET | `/api/tuples` | Lists relation tuples. |
| POST | `/api/tuples` | Creates a relation tuple. |
| PATCH | `/api/tuples/:id` | Replaces a tuple with the same object and subject but a new relation. |
| DELETE | `/api/tuples/:id` | Deletes a relation tuple. |
| POST | `/api/tuples/batch` | Batch creates and deletes tuples. |
| POST | `/api/check` | Checks whether a subject has a relation on an object. |
| POST | `/api/expand` | Expands a relation tree. |
| GET | `/api/account/users/:id/access` | Lists tuples where the user is the subject. |
| GET | `/api/account/groups/:id/access` | Lists tuples where the group is the subject. |
| GET | `/api/policy/entities` | Lists users, groups, and resource groups for the policy UI. |
| GET | `/api/resource-groups` | Lists resource groups. |
| POST | `/api/resource-groups` | Creates a resource group. |
| DELETE | `/api/resource-groups/:id` | Deletes a resource group. |
| GET | `/api/resource-groups/:id/members` | Lists resource group members. |
| POST | `/api/resource-groups/:id/members` | Adds a resource group member. |
| DELETE | `/api/resource-groups/:id/members/:tupleId` | Removes a resource group member. |

## Create Tuple Request

```json
{
  "namespace": "document",
  "objectId": "doc123",
  "relation": "viewer",
  "subjectNamespace": "group",
  "subjectId": "group123",
  "subjectRelation": "member"
}
```

For group subjects, `subjectRelation` defaults to `member` when omitted.

## Check Request

```json
{
  "namespace": "document",
  "objectId": "doc123",
  "relation": "viewer",
  "subjectNamespace": "user",
  "subjectId": "user123"
}
```

## Resource Groups

Resource groups are policy-managed groupings of objects. A member is added by object namespace and object ID:

```json
{
  "namespace": "document",
  "objectId": "doc123"
}
```

## Account Subjects

Users and groups come from the account module. Group membership uses group IDs in route paths:

```text
POST /api/account/groups/:id/members
DELETE /api/account/groups/:id/members/:userId
```

Do not use group names in account group member route paths unless the route implementation changes.
