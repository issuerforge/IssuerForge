// ЗГЕНЕРОВАНО `pnpm idl:sync` з target/types. Руками не редагувати.
//
// Тип — те, що згенерував `anchor build`; значення — той самий текст під
// анотацією цього типу. Анотація не декоративна: вона і є перевіркою, що
// вендорована копія не розійшлася з програмою — зайве поле чи інше ім'я не
// скомпілюється.
//
// Імена всередині лишаються такими, як їх пише Anchor: `Program` проганяє
// переданий IDL через власну конверсію в camelCase, тож форма запису тут на
// рантайм не впливає.

export type IssuerForge = {
  "address": "ForgePo1icy11111111111111111111111111111111",
  "metadata": {
    "name": "issuerForge",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Compliance rules as data: one audited program serving every stablecoin issuer"
  },
  "instructions": [
    {
      "name": "initializeIssuer",
      "docs": [
        "Створює емітента: склад уповноважених, поріг кворуму й межі, у яких",
        "операційний ключ платформи може діяти (FR-019a, FR-033, FR-035).",
        "",
        "Єдина дія емітента, що не проходить кворум, — бо до неї кворуму ще",
        "немає. Усе, що вона задає, змінюється далі **тільки** кворумом."
      ],
      "discriminator": [
        231,
        164,
        134,
        90,
        62,
        217,
        189,
        118
      ],
      "accounts": [
        {
          "name": "issuerConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  115,
                  115,
                  117,
                  101,
                  114
                ]
              },
              {
                "kind": "arg",
                "path": "args.issuer_id"
              }
            ]
          }
        },
        {
          "name": "payer",
          "docs": [
            "Хто платить оренду. Свідомо відділений від `founder`: гаманець офіцера,",
            "створений через Privy, законно має нуль SOL, і вимагати від нього",
            "платити означало б, що вхід без криптодосвіду (FR-034) не працює на",
            "першому ж кроці. Повноважень цей підпис не дає — жодна перевірка нижче",
            "його не питає."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "founder",
          "docs": [
            "Хто засновує. Мусить бути в складі з роллю адміністратора: емітента не",
            "можна створити від імені людей, серед яких тебе немає."
          ],
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "initializeIssuerArgs"
            }
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "issuerConfig",
      "discriminator": [
        238,
        244,
        71,
        221,
        254,
        169,
        247,
        237
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "policyVersionMismatch",
      "msg": "policy version does not match the one this mint is configured for"
    },
    {
      "code": 6001,
      "name": "senderStatusMissing",
      "msg": "sender has no status account"
    },
    {
      "code": 6002,
      "name": "recipientStatusMissing",
      "msg": "recipient has no status account"
    },
    {
      "code": 6003,
      "name": "statusSourceNotAccepted",
      "msg": "status comes from a source this rule does not accept"
    },
    {
      "code": 6004,
      "name": "statusSourceUnavailable",
      "msg": "a status source required by the policy is unavailable"
    },
    {
      "code": 6005,
      "name": "senderDenied",
      "msg": "sender is on the issuer's denied register"
    },
    {
      "code": 6006,
      "name": "recipientDenied",
      "msg": "recipient is on the issuer's denied register"
    },
    {
      "code": 6007,
      "name": "recipientTierTooLow",
      "msg": "recipient verification tier is below the minimum"
    },
    {
      "code": 6008,
      "name": "recipientJurisdictionNotAllowed",
      "msg": "recipient jurisdiction is not allowed to hold this token"
    },
    {
      "code": 6009,
      "name": "transferLimitExceeded",
      "msg": "amount exceeds the single-transfer limit"
    },
    {
      "code": 6010,
      "name": "velocityCounterMissing",
      "msg": "sender has no velocity counter"
    },
    {
      "code": 6011,
      "name": "periodLimitExceeded",
      "msg": "amount exceeds the limit for the period"
    },
    {
      "code": 6012,
      "name": "tooFewMembers",
      "msg": "issuer must have at least two members to reach a quorum"
    },
    {
      "code": 6013,
      "name": "tooManyMembers",
      "msg": "member list exceeds the fixed capacity"
    },
    {
      "code": 6014,
      "name": "duplicateMember",
      "msg": "the same wallet appears twice in the member list"
    },
    {
      "code": 6015,
      "name": "memberWithoutRole",
      "msg": "a member must hold at least one role"
    },
    {
      "code": 6016,
      "name": "unknownRole",
      "msg": "role mask contains a bit this program does not define"
    },
    {
      "code": 6017,
      "name": "attestorHoldsOtherRoles",
      "msg": "the reserve attestor may hold no other role"
    },
    {
      "code": 6018,
      "name": "quorumTooSmall",
      "msg": "quorum must be at least two"
    },
    {
      "code": 6019,
      "name": "quorumExceedsSigners",
      "msg": "quorum exceeds the number of members who may authorise actions"
    },
    {
      "code": 6020,
      "name": "notAnAdmin",
      "msg": "signer is not an administrator of this issuer"
    },
    {
      "code": 6021,
      "name": "undelegatablePower",
      "msg": "delegation mask contains a power that can never be delegated"
    },
    {
      "code": 6022,
      "name": "missingOperationalKey",
      "msg": "operational key must be a real address"
    }
  ],
  "types": [
    {
      "name": "initializeIssuerArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "issuerId",
            "docs": [
              "Незмінний ідентифікатор емітента — seed його PDA. Генерується клієнтом і",
              "нічого не підписує, тож ключем від нього володіти не обов'язково."
            ],
            "type": "pubkey"
          },
          {
            "name": "members",
            "docs": [
              "Початковий склад: адреса й маска ролей. Порядок стає індексом у бітмапі",
              "підписів `ActionProposal`, тому зберігається як переданий."
            ],
            "type": {
              "vec": {
                "defined": {
                  "name": "member"
                }
              }
            }
          },
          {
            "name": "quorumN",
            "type": "u8"
          },
          {
            "name": "operationalKey",
            "type": "pubkey"
          },
          {
            "name": "delegationMask",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "issuerConfig",
      "docs": [
        "Конфігурація емітента. PDA: `[\"issuer\", issuer_id]`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "issuerId",
            "docs": [
              "Незмінний ідентифікатор, з якого виведена адреса цього акаунта. Нічого",
              "не підписує: його єдина робота — бути seed, який переживає зміну складу."
            ],
            "type": "pubkey"
          },
          {
            "name": "members",
            "docs": [
              "Склад фіксованої довжини. Порядок рядків значущий: бітмапа підписів у",
              "`ActionProposal` індексує саме його, тож видалення учасника не має",
              "зсувати решту — звільнений слот лишається порожнім."
            ],
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "member"
                  }
                },
                8
              ]
            }
          },
          {
            "name": "memberSlots",
            "docs": [
              "Скільки слотів зайнято. Не збігається з кількістю непорожніх слотів",
              "після видалень — це верхня межа обходу, а не лічильник учасників."
            ],
            "type": "u8"
          },
          {
            "name": "quorumN",
            "docs": [
              "Поріг кворуму (FR-019). Не менший за `MIN_QUORUM`."
            ],
            "type": "u8"
          },
          {
            "name": "operationalKey",
            "docs": [
              "Операційний ключ платформи. Грошей не рухає (FR-035a)."
            ],
            "type": "pubkey"
          },
          {
            "name": "delegationMask",
            "docs": [
              "Що саме йому делеговано. Відкликається однією дією (FR-035b)."
            ],
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "member",
      "docs": [
        "Рядок складу вповноважених: адреса гаманця й маска її ролей.",
        "",
        "Роль прив'язана до адреси, а не до облікового запису входу (FR-034a): зміна",
        "способу входу не змінює повноважень, а втрата доступу до акаунта не передає",
        "роль іншій адресі."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "wallet",
            "type": "pubkey"
          },
          {
            "name": "roles",
            "type": "u8"
          }
        ]
      }
    }
  ]
}

export const IDL: IssuerForge = {
  "address": "ForgePo1icy11111111111111111111111111111111",
  "metadata": {
    "name": "issuerForge",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Compliance rules as data: one audited program serving every stablecoin issuer"
  },
  "instructions": [
    {
      "name": "initializeIssuer",
      "docs": [
        "Створює емітента: склад уповноважених, поріг кворуму й межі, у яких",
        "операційний ключ платформи може діяти (FR-019a, FR-033, FR-035).",
        "",
        "Єдина дія емітента, що не проходить кворум, — бо до неї кворуму ще",
        "немає. Усе, що вона задає, змінюється далі **тільки** кворумом."
      ],
      "discriminator": [
        231,
        164,
        134,
        90,
        62,
        217,
        189,
        118
      ],
      "accounts": [
        {
          "name": "issuerConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  115,
                  115,
                  117,
                  101,
                  114
                ]
              },
              {
                "kind": "arg",
                "path": "args.issuer_id"
              }
            ]
          }
        },
        {
          "name": "payer",
          "docs": [
            "Хто платить оренду. Свідомо відділений від `founder`: гаманець офіцера,",
            "створений через Privy, законно має нуль SOL, і вимагати від нього",
            "платити означало б, що вхід без криптодосвіду (FR-034) не працює на",
            "першому ж кроці. Повноважень цей підпис не дає — жодна перевірка нижче",
            "його не питає."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "founder",
          "docs": [
            "Хто засновує. Мусить бути в складі з роллю адміністратора: емітента не",
            "можна створити від імені людей, серед яких тебе немає."
          ],
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "initializeIssuerArgs"
            }
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "issuerConfig",
      "discriminator": [
        238,
        244,
        71,
        221,
        254,
        169,
        247,
        237
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "policyVersionMismatch",
      "msg": "policy version does not match the one this mint is configured for"
    },
    {
      "code": 6001,
      "name": "senderStatusMissing",
      "msg": "sender has no status account"
    },
    {
      "code": 6002,
      "name": "recipientStatusMissing",
      "msg": "recipient has no status account"
    },
    {
      "code": 6003,
      "name": "statusSourceNotAccepted",
      "msg": "status comes from a source this rule does not accept"
    },
    {
      "code": 6004,
      "name": "statusSourceUnavailable",
      "msg": "a status source required by the policy is unavailable"
    },
    {
      "code": 6005,
      "name": "senderDenied",
      "msg": "sender is on the issuer's denied register"
    },
    {
      "code": 6006,
      "name": "recipientDenied",
      "msg": "recipient is on the issuer's denied register"
    },
    {
      "code": 6007,
      "name": "recipientTierTooLow",
      "msg": "recipient verification tier is below the minimum"
    },
    {
      "code": 6008,
      "name": "recipientJurisdictionNotAllowed",
      "msg": "recipient jurisdiction is not allowed to hold this token"
    },
    {
      "code": 6009,
      "name": "transferLimitExceeded",
      "msg": "amount exceeds the single-transfer limit"
    },
    {
      "code": 6010,
      "name": "velocityCounterMissing",
      "msg": "sender has no velocity counter"
    },
    {
      "code": 6011,
      "name": "periodLimitExceeded",
      "msg": "amount exceeds the limit for the period"
    },
    {
      "code": 6012,
      "name": "tooFewMembers",
      "msg": "issuer must have at least two members to reach a quorum"
    },
    {
      "code": 6013,
      "name": "tooManyMembers",
      "msg": "member list exceeds the fixed capacity"
    },
    {
      "code": 6014,
      "name": "duplicateMember",
      "msg": "the same wallet appears twice in the member list"
    },
    {
      "code": 6015,
      "name": "memberWithoutRole",
      "msg": "a member must hold at least one role"
    },
    {
      "code": 6016,
      "name": "unknownRole",
      "msg": "role mask contains a bit this program does not define"
    },
    {
      "code": 6017,
      "name": "attestorHoldsOtherRoles",
      "msg": "the reserve attestor may hold no other role"
    },
    {
      "code": 6018,
      "name": "quorumTooSmall",
      "msg": "quorum must be at least two"
    },
    {
      "code": 6019,
      "name": "quorumExceedsSigners",
      "msg": "quorum exceeds the number of members who may authorise actions"
    },
    {
      "code": 6020,
      "name": "notAnAdmin",
      "msg": "signer is not an administrator of this issuer"
    },
    {
      "code": 6021,
      "name": "undelegatablePower",
      "msg": "delegation mask contains a power that can never be delegated"
    },
    {
      "code": 6022,
      "name": "missingOperationalKey",
      "msg": "operational key must be a real address"
    }
  ],
  "types": [
    {
      "name": "initializeIssuerArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "issuerId",
            "docs": [
              "Незмінний ідентифікатор емітента — seed його PDA. Генерується клієнтом і",
              "нічого не підписує, тож ключем від нього володіти не обов'язково."
            ],
            "type": "pubkey"
          },
          {
            "name": "members",
            "docs": [
              "Початковий склад: адреса й маска ролей. Порядок стає індексом у бітмапі",
              "підписів `ActionProposal`, тому зберігається як переданий."
            ],
            "type": {
              "vec": {
                "defined": {
                  "name": "member"
                }
              }
            }
          },
          {
            "name": "quorumN",
            "type": "u8"
          },
          {
            "name": "operationalKey",
            "type": "pubkey"
          },
          {
            "name": "delegationMask",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "issuerConfig",
      "docs": [
        "Конфігурація емітента. PDA: `[\"issuer\", issuer_id]`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "issuerId",
            "docs": [
              "Незмінний ідентифікатор, з якого виведена адреса цього акаунта. Нічого",
              "не підписує: його єдина робота — бути seed, який переживає зміну складу."
            ],
            "type": "pubkey"
          },
          {
            "name": "members",
            "docs": [
              "Склад фіксованої довжини. Порядок рядків значущий: бітмапа підписів у",
              "`ActionProposal` індексує саме його, тож видалення учасника не має",
              "зсувати решту — звільнений слот лишається порожнім."
            ],
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "member"
                  }
                },
                8
              ]
            }
          },
          {
            "name": "memberSlots",
            "docs": [
              "Скільки слотів зайнято. Не збігається з кількістю непорожніх слотів",
              "після видалень — це верхня межа обходу, а не лічильник учасників."
            ],
            "type": "u8"
          },
          {
            "name": "quorumN",
            "docs": [
              "Поріг кворуму (FR-019). Не менший за `MIN_QUORUM`."
            ],
            "type": "u8"
          },
          {
            "name": "operationalKey",
            "docs": [
              "Операційний ключ платформи. Грошей не рухає (FR-035a)."
            ],
            "type": "pubkey"
          },
          {
            "name": "delegationMask",
            "docs": [
              "Що саме йому делеговано. Відкликається однією дією (FR-035b)."
            ],
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "member",
      "docs": [
        "Рядок складу вповноважених: адреса гаманця й маска її ролей.",
        "",
        "Роль прив'язана до адреси, а не до облікового запису входу (FR-034a): зміна",
        "способу входу не змінює повноважень, а втрата доступу до акаунта не передає",
        "роль іншій адресі."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "wallet",
            "type": "pubkey"
          },
          {
            "name": "roles",
            "type": "u8"
          }
        ]
      }
    }
  ]
}
