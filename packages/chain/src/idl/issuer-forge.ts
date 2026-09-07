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
    },
    {
      "name": "setHolderStatus",
      "docs": [
        "Оновлює статус адреси у власному реєстрі емітента (FR-008a, FR-008b1).",
        "",
        "Ця інструкція й робить FR-008b1 виконуваним: рахунок лишається",
        "розмороженим, а переказ із нього перестає проходити тієї ж миті, коли",
        "статус більше не задовольняє політику."
      ],
      "discriminator": [
        121,
        5,
        238,
        79,
        85,
        126,
        216,
        174
      ],
      "accounts": [
        {
          "name": "issuerConfig",
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
                "kind": "account",
                "path": "issuer_config.issuer_id",
                "account": "issuerConfig"
              }
            ]
          }
        },
        {
          "name": "tokenConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "token_config.mint",
                "account": "tokenConfig"
              }
            ]
          }
        },
        {
          "name": "holderStatus",
          "docs": [
            "Без `init`: запису, якого немає, ця інструкція не заводить. Створення",
            "прив'язане до розморожування, бо статус без розмороженого рахунку нічого",
            "не означає, а `HolderStatus` без `VelocityCounter` дав би відмову в",
            "переказі там, де емітент вважає холдера впорядкованим."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "token_config.mint",
                "account": "tokenConfig"
              },
              {
                "kind": "arg",
                "path": "args.wallet"
              }
            ]
          }
        },
        {
          "name": "authority",
          "signer": true
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "setHolderStatusArgs"
            }
          }
        }
      ]
    },
    {
      "name": "setPolicy",
      "docs": [
        "Записує наступну версію політики й переводить токен на неї (FR-009,",
        "FR-010).",
        "",
        "Зміна набуває сили без повторного випуску токена й без дій з боку",
        "холдерів: політика — дані, і хук читає нову версію вже на наступному",
        "переказі. Попередні версії лишаються на своїх адресах назавжди.",
        "",
        "Санкціонує зміну кворум гаманців емітента (FR-035), а не операційний",
        "ключ платформи: підписи передаються в `remaining_accounts`."
      ],
      "discriminator": [
        40,
        133,
        12,
        157,
        235,
        202,
        2,
        132
      ],
      "accounts": [
        {
          "name": "issuerConfig",
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
                "kind": "account",
                "path": "issuer_config.issuer_id",
                "account": "issuerConfig"
              }
            ]
          }
        },
        {
          "name": "tokenConfig",
          "docs": [
            "Мусить іти перед `policy_config`: його `mint` є seed'ом наступного",
            "акаунта, а Anchor перевіряє поля в порядку оголошення."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "token_config.mint",
                "account": "tokenConfig"
              }
            ]
          }
        },
        {
          "name": "policyConfig",
          "docs": [
            "Нова версія. `init` тут і є незмінністю історії (FR-010): версія, яка вже",
            "існує, не створюється вдруге, а інструкції, що відкрила б її на запис, у",
            "програмі немає."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "token_config.mint",
                "account": "tokenConfig"
              },
              {
                "kind": "arg",
                "path": "args.version"
              }
            ]
          }
        },
        {
          "name": "payer",
          "docs": [
            "Хто платить оренду за нову версію. Повноважень цей підпис не дає — їх",
            "дає тільки кворум серед `remaining_accounts`."
          ],
          "writable": true,
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
              "name": "setPolicyArgs"
            }
          }
        }
      ]
    },
    {
      "name": "thawHolder",
      "docs": [
        "Розморожує рахунок холдера й заводить обидва акаунти, без яких переказ",
        "відмовляє: `HolderStatus` і `VelocityCounter` (FR-008b).",
        "",
        "Хук не створює акаунтів, тож їх створюють тут — наперед. Саме",
        "розморожування дозволом на переказ не є (FR-008b1): правила політики",
        "перевіряються на кожному переказі окремо."
      ],
      "discriminator": [
        56,
        60,
        31,
        119,
        186,
        131,
        171,
        109
      ],
      "accounts": [
        {
          "name": "issuerConfig",
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
                "kind": "account",
                "path": "issuer_config.issuer_id",
                "account": "issuerConfig"
              }
            ]
          }
        },
        {
          "name": "tokenConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "token_config.mint",
                "account": "tokenConfig"
              }
            ]
          }
        },
        {
          "name": "mint",
          "writable": true
        },
        {
          "name": "tokenAccount",
          "docs": [
            "Токен-акаунт холдера. Обидві перевірки обов'язкові: адреса акаунта не",
            "доводить ані його mint, ані власника, а статус виводиться саме з",
            "`wallet`."
          ],
          "writable": true
        },
        {
          "name": "holderStatus",
          "docs": [
            "`init_if_needed`, бо рахунок законно розморожують удруге — після",
            "заморозки офіцером. Повторне створення нічого не переписує: що саме",
            "пишеться, вирішує `updated_at`, а не наявність акаунта."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "token_config.mint",
                "account": "tokenConfig"
              },
              {
                "kind": "arg",
                "path": "args.wallet"
              }
            ]
          }
        },
        {
          "name": "velocityCounter",
          "docs": [
            "Так само `init_if_needed` — і **жодне поле лічильника тут не пишеться**,",
            "крім `bump`. Скидання вікна операційним ключем зняло б ліміт за період",
            "рутинною дією, тобто дало б повноваження, якого в масці делегації немає",
            "й не може бути (FR-035a)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  101,
                  108,
                  111,
                  99,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "token_config.mint",
                "account": "tokenConfig"
              },
              {
                "kind": "arg",
                "path": "args.wallet"
              }
            ]
          }
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "authority",
          "docs": [
            "Операційний ключ платформи або уповноважений учасник складу."
          ],
          "signer": true
        },
        {
          "name": "tokenProgram"
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
              "name": "thawHolderArgs"
            }
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "holderStatus",
      "discriminator": [
        67,
        242,
        217,
        54,
        237,
        58,
        108,
        127
      ]
    },
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
    },
    {
      "name": "policyConfig",
      "discriminator": [
        219,
        7,
        79,
        84,
        175,
        51,
        148,
        146
      ]
    },
    {
      "name": "tokenConfig",
      "discriminator": [
        92,
        73,
        255,
        43,
        107,
        51,
        117,
        101
      ]
    },
    {
      "name": "velocityCounter",
      "discriminator": [
        155,
        85,
        56,
        107,
        143,
        157,
        165,
        171
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
      "name": "unknownRuleKind",
      "msg": "policy carries a rule kind this version of the program does not know"
    },
    {
      "code": 6013,
      "name": "tooFewMembers",
      "msg": "issuer must have at least two members to reach a quorum"
    },
    {
      "code": 6014,
      "name": "tooManyMembers",
      "msg": "member list exceeds the fixed capacity"
    },
    {
      "code": 6015,
      "name": "duplicateMember",
      "msg": "the same wallet appears twice in the member list"
    },
    {
      "code": 6016,
      "name": "memberWithoutRole",
      "msg": "a member must hold at least one role"
    },
    {
      "code": 6017,
      "name": "unknownRole",
      "msg": "role mask contains a bit this program does not define"
    },
    {
      "code": 6018,
      "name": "attestorHoldsOtherRoles",
      "msg": "the reserve attestor may hold no other role"
    },
    {
      "code": 6019,
      "name": "quorumTooSmall",
      "msg": "quorum must be at least two"
    },
    {
      "code": 6020,
      "name": "quorumExceedsSigners",
      "msg": "quorum exceeds the number of members who may authorise actions"
    },
    {
      "code": 6021,
      "name": "notAnAdmin",
      "msg": "signer is not an administrator of this issuer"
    },
    {
      "code": 6022,
      "name": "undelegatablePower",
      "msg": "delegation mask contains a power that can never be delegated"
    },
    {
      "code": 6023,
      "name": "missingOperationalKey",
      "msg": "operational key must be a real address"
    },
    {
      "code": 6024,
      "name": "tokenNotFromThisIssuer",
      "msg": "token config does not belong to this issuer"
    },
    {
      "code": 6025,
      "name": "policyVersionNotNext",
      "msg": "policy version must be exactly one past the version this mint is on"
    },
    {
      "code": 6026,
      "name": "policyRulesNotCanonical",
      "msg": "rule slots are not in the single canonical form this program accepts"
    },
    {
      "code": 6027,
      "name": "policyRuleKindUnknown",
      "msg": "policy carries a rule kind this program does not define"
    },
    {
      "code": 6028,
      "name": "policyRuleParamsOutOfRange",
      "msg": "a rule parameter lies outside the range the model allows"
    },
    {
      "code": 6029,
      "name": "policyStatusRuleMissing",
      "msg": "a policy must carry the status rule"
    },
    {
      "code": 6030,
      "name": "notAnAuthorisingSigner",
      "msg": "signer is not a member who may authorise actions for this issuer"
    },
    {
      "code": 6031,
      "name": "duplicateApproval",
      "msg": "the same wallet approved twice"
    },
    {
      "code": 6032,
      "name": "quorumNotReached",
      "msg": "action did not reach the issuer's quorum"
    },
    {
      "code": 6033,
      "name": "powerNotDelegated",
      "msg": "this power is not delegated to the operational key"
    },
    {
      "code": 6034,
      "name": "notAnOperatorOrOfficer",
      "msg": "signer is neither the operational key nor an officer of this issuer"
    },
    {
      "code": 6035,
      "name": "holderJurisdictionInvalid",
      "msg": "jurisdiction must be an upper-case ISO 3166-1 alpha-2 code"
    },
    {
      "code": 6036,
      "name": "holderStatusAlreadyExpired",
      "msg": "a status that is already expired when written would read as absent"
    },
    {
      "code": 6037,
      "name": "holderStatusRequired",
      "msg": "the first thaw must carry the holder status"
    },
    {
      "code": 6038,
      "name": "holderStatusAlreadySet",
      "msg": "this holder already has a status; change it with set_holder_status"
    },
    {
      "code": 6039,
      "name": "holderAccountMismatch",
      "msg": "token account does not belong to this mint or to this wallet"
    }
  ],
  "types": [
    {
      "name": "holderStatus",
      "docs": [
        "Статус адреси у власному реєстрі емітента. PDA: `[\"holder\", mint, wallet]`.",
        "",
        "Це **одне з двох** джерел статусу (FR-008a); друге — атестація провайдера,",
        "яку хук читає напряму зі спільного сервісу атестацій (спайк T057).",
        "",
        "**Двох полів із `docs/PLAN.md` тут немає, і це свідомо:**",
        "- `source` (issuer/provider) був потрібен, поки статус провайдера планували",
        "дзеркалити сюди. T057 закрив це питання інакше — атестація читається",
        "напряму, — тож поле означало б «джерело цього запису в реєстрі емітента",
        "не емітент», чого не буває.",
        "- `thawed` був би другим джерелом правди про стан, який авторитетно тримає",
        "сам токен-акаунт (`DefaultAccountState`, `freeze_account`). Офіцер може",
        "заморозити рахунок (T026), не торкаючись цього акаунта, і прапорець тут",
        "одразу став би брехнею. Черга на розморожування (FR-008b2) живе офчейн.",
        "",
        "Через це `flags` звівся до одного значення й лишився `bool`: бітмаска на",
        "один біт — це маска, яку читають, звіряючись із коментарем."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "docs": [
              "Обидва поля дублюють seeds навмисно: консоль і індексатор шукають",
              "холдерів через `getProgramAccounts` із фільтром за mint, а зробити такий",
              "фільтр по seeds неможливо."
            ],
            "type": "pubkey"
          },
          {
            "name": "wallet",
            "type": "pubkey"
          },
          {
            "name": "tier",
            "docs": [
              "Рівень верифікації, як його присвоїв емітент."
            ],
            "type": "u8"
          },
          {
            "name": "jurisdiction",
            "docs": [
              "Код ISO 3166-1 alpha-2 у верхньому регістрі."
            ],
            "type": {
              "array": [
                "u8",
                2
              ]
            }
          },
          {
            "name": "denied",
            "docs": [
              "Заборона емітента. Діє **незалежно** від того, чи приймає політика це",
              "джерело (FR-008a1): власний реєстр звужує коло, дозволене провайдером, і",
              "ніколи його не розширює."
            ],
            "type": "bool"
          },
          {
            "name": "expiresAt",
            "docs": [
              "Строк придатності запису, unix-секунди. **Нуль означає «без строку»**, а",
              "не «протерміновано»: запис без строку — дійсний стан реєстру, і саме він",
              "відрізняє реєстр від атестації, яка строк має завжди."
            ],
            "type": "i64"
          },
          {
            "name": "updatedAt",
            "docs": [
              "Коли запис востаннє писали.",
              "",
              "Не декорація: **нуль тут означає «запису ще не було»**. Свіжостворений",
              "акаунт весь нульовий, а жоден справжній запис не має нульового часу",
              "блоку, тож `thaw_holder` за цим полем відрізняє перше розморожування від",
              "повторного — і не переписує статус, якого йому не доручали писати."
            ],
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "holderStatusInput",
      "docs": [
        "Значення статусу, які приносить інструкція.",
        "",
        "Окремий тип від акаунта: в акаунті є ще й `mint`, `wallet`, `bump` і",
        "`updated_at`, і жодне з них клієнт не задає."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "tier",
            "type": "u8"
          },
          {
            "name": "jurisdiction",
            "type": {
              "array": [
                "u8",
                2
              ]
            }
          },
          {
            "name": "denied",
            "type": "bool"
          },
          {
            "name": "expiresAt",
            "docs": [
              "Нуль — без строку."
            ],
            "type": "i64"
          }
        ]
      }
    },
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
    },
    {
      "name": "policyConfig",
      "docs": [
        "Версія політики. PDA: `[\"policy\", mint, version]`, версія — `u32` LE.",
        "",
        "**Незмінність історії — властивість адреси, а не перевірки в коді.** Кожна",
        "версія живе за власним PDA й створюється через `init`, тож повторний запис у",
        "вже існуючу версію відхиляє рантайм, а не наша логіка (FR-010). Перезаписати",
        "попередню версію нічим: інструкції, яка б відкрила її на запис, у програмі",
        "немає.",
        "",
        "`zero_copy`, бо хук читає `rules` на **кожному** переказі: десеріалізація",
        "Borsh 384 байтів у CU-бюджеті хука коштувала б дорожче за саму перевірку.",
        "Звідси `#[repr(C)]`, явна набивка до восьми байтів і `AccountLoader` замість",
        "`Account` на боці інструкцій."
      ],
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "activatedAt",
            "docs": [
              "Час активації, unix-секунди — половина того, чого вимагає FR-010."
            ],
            "type": "i64"
          },
          {
            "name": "version",
            "type": "u32"
          },
          {
            "name": "author",
            "docs": [
              "Хто ініціював зміну — перший підпис із зібраного кворуму.",
              "",
              "Поіменний склад усіх, хто санкціонував дію (FR-019c), тут не лежить",
              "навмисно: він належить журналу й `ActionProposal` (T025, T029), а",
              "шістнадцять адрес у кожній версії політики були б третім дзеркалом того",
              "самого факту."
            ],
            "type": "pubkey"
          },
          {
            "name": "rules",
            "docs": [
              "Правила у канонічній розкладці. Порядок і межі тримає `rules::layout`."
            ],
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "ruleSlot"
                  }
                },
                16
              ]
            }
          },
          {
            "name": "rulesHash",
            "docs": [
              "sha256 над усім полем `rules`, порахований програмою при записі.",
              "",
              "Рахується тут, а не приймається від клієнта: хеш, який приніс той самий,",
              "хто приніс байти, доводить лише те, що клієнт уміє рахувати хеші."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "padding",
            "docs": [
              "Явна набивка до вирівнювання 8. Без неї `bytemuck::Pod` не виводиться, а",
              "мовчазна набивка компілятора потрапила б у хеш акаунта як сміття."
            ],
            "type": {
              "array": [
                "u8",
                3
              ]
            }
          }
        ]
      }
    },
    {
      "name": "ruleSlot",
      "docs": [
        "Один слот правила, як він лежить в акаунті."
      ],
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "kind",
            "type": "u8"
          },
          {
            "name": "op",
            "type": "u8"
          },
          {
            "name": "params",
            "type": {
              "array": [
                "u8",
                22
              ]
            }
          }
        ]
      }
    },
    {
      "name": "setHolderStatusArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "wallet",
            "type": "pubkey"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "holderStatusInput"
              }
            }
          }
        ]
      }
    },
    {
      "name": "setPolicyArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "docs": [
              "Номер нової версії. Мусить бути рівно наступним за чинною: пропуск",
              "зробив би «попередню версію» невиводимою з номера, а історію — переліком",
              "з дірками, який нічим не звірити."
            ],
            "type": "u32"
          },
          {
            "name": "rules",
            "docs": [
              "Правила в канонічній розкладці, рівно `RULES_BYTES` байтів.",
              "",
              "`Vec<u8>`, а не масив: Borsh описує його як `bytes`, і IDL лишається",
              "читабельним для клієнта. Довжину перевіряє програма."
            ],
            "type": "bytes"
          }
        ]
      }
    },
    {
      "name": "thawHolderArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "wallet",
            "docs": [
              "Власник рахунку. Мусить збігтися з `owner` токен-акаунта — інакше",
              "статус ліг би за адресою, якої переказ ніколи не прочитає."
            ],
            "type": "pubkey"
          },
          {
            "name": "status",
            "docs": [
              "Початковий статус — тільки для **першого** розморожування.",
              "",
              "`None` означає «запис уже є, я його не чіпаю»: так виглядає повторне",
              "розморожування після заморозки офіцером (T026). Розбіжність між",
              "наміром і станом акаунта відхиляється, а не тлумачиться, тож жоден",
              "виклик не змінює статусу мовчки."
            ],
            "type": {
              "option": {
                "defined": {
                  "name": "holderStatusInput"
                }
              }
            }
          }
        ]
      }
    },
    {
      "name": "tokenConfig",
      "docs": [
        "Конфігурація випущеного токена. PDA: `[\"token\", mint]`.",
        "",
        "**Порядок полів тут — частина протоколу, а не стиль.** Хук отримує акаунт",
        "атестації провайдера через `ExtraAccountMetaList`, а її адреса виводиться з",
        "seeds `[\"attestation\", credential, schema, nonce]` (спайк T057). Два",
        "32-байтові літерали в 32-байтовий `address_config` не вміщаються ніколи, тож",
        "`credential` і `schema` беруться **зрізами даних цього акаунта** — а зсув у",
        "seed `AccountData` має розмір рівно одного байта.",
        "",
        "Звідси два обмеження, які тепер є вимогами до розкладки:",
        "- обидва поля мусять лежати в перших 256 байтах акаунта;",
        "- їхні зсуви зашиті в `address_config` уже створених `ExtraAccountMetaList`,",
        "тож вставка нового поля **перед ними** мовчки перенаправить хук на чужі",
        "32 байти. Тест `token_config_offsets_are_pinned` існує саме проти цього."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "issuer",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "attestationCredential",
            "docs": [
              "SAS-credential провайдера верифікації, атестації якого приймає цей токен."
            ],
            "type": "pubkey"
          },
          {
            "name": "attestationSchema",
            "docs": [
              "SAS-schema тих атестацій."
            ],
            "type": "pubkey"
          },
          {
            "name": "attestor",
            "docs": [
              "Чинний атестатор резерву **цього токена** (FR-024b).",
              "",
              "Живе тут, а не в `IssuerConfig`, попри `docs/PLAN.md`: FR-024b перевіряє",
              "підпис проти атестатора конкретного токена, і емітент із двома токенами",
              "законно має для них різних атестаторів."
            ],
            "type": "pubkey"
          },
          {
            "name": "treasury",
            "docs": [
              "Скарбниця платформи: сюди йде комісія з емісії й погашення (FR-038)."
            ],
            "type": "pubkey"
          },
          {
            "name": "policyVersion",
            "docs": [
              "Версія політики, на яку налаштований mint. Розбіжність — перша перевірка",
              "хука й перший код відмови."
            ],
            "type": "u32"
          },
          {
            "name": "feeBps",
            "docs": [
              "Оголошена ставка комісії (FR-038a)."
            ],
            "type": "u16"
          },
          {
            "name": "attestationMaxAge",
            "docs": [
              "Строк придатності атестації, секунди (FR-023b)."
            ],
            "type": "i64"
          },
          {
            "name": "pausedAt",
            "docs": [
              "Дзеркало стану паузи для журналу й екранів; `0` — не на паузі.",
              "Авторитетним лишається розширення `Pausable` на самому mint (FR-016)."
            ],
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "velocityCounter",
      "docs": [
        "Лічильник ліміту за період. PDA: `[\"velocity\", mint, wallet]`.",
        "",
        "`mint` і `wallet` тут **не** дублюються, на відміну від `HolderStatus`:",
        "лічильник читає тільки хук, за виведеною адресою, і жодного сканування за",
        "фільтром по ньому не буває. Зайві 64 байти на кожного холдера — це оренда,",
        "яку платить емітент."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "windowStart",
            "docs": [
              "Початок поточного вікна. Нуль означає, що вікна ще не було."
            ],
            "type": "i64"
          },
          {
            "name": "spentInWindow",
            "type": "u64"
          },
          {
            "name": "bump",
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
    },
    {
      "name": "setHolderStatus",
      "docs": [
        "Оновлює статус адреси у власному реєстрі емітента (FR-008a, FR-008b1).",
        "",
        "Ця інструкція й робить FR-008b1 виконуваним: рахунок лишається",
        "розмороженим, а переказ із нього перестає проходити тієї ж миті, коли",
        "статус більше не задовольняє політику."
      ],
      "discriminator": [
        121,
        5,
        238,
        79,
        85,
        126,
        216,
        174
      ],
      "accounts": [
        {
          "name": "issuerConfig",
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
                "kind": "account",
                "path": "issuer_config.issuer_id",
                "account": "issuerConfig"
              }
            ]
          }
        },
        {
          "name": "tokenConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "token_config.mint",
                "account": "tokenConfig"
              }
            ]
          }
        },
        {
          "name": "holderStatus",
          "docs": [
            "Без `init`: запису, якого немає, ця інструкція не заводить. Створення",
            "прив'язане до розморожування, бо статус без розмороженого рахунку нічого",
            "не означає, а `HolderStatus` без `VelocityCounter` дав би відмову в",
            "переказі там, де емітент вважає холдера впорядкованим."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "token_config.mint",
                "account": "tokenConfig"
              },
              {
                "kind": "arg",
                "path": "args.wallet"
              }
            ]
          }
        },
        {
          "name": "authority",
          "signer": true
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "setHolderStatusArgs"
            }
          }
        }
      ]
    },
    {
      "name": "setPolicy",
      "docs": [
        "Записує наступну версію політики й переводить токен на неї (FR-009,",
        "FR-010).",
        "",
        "Зміна набуває сили без повторного випуску токена й без дій з боку",
        "холдерів: політика — дані, і хук читає нову версію вже на наступному",
        "переказі. Попередні версії лишаються на своїх адресах назавжди.",
        "",
        "Санкціонує зміну кворум гаманців емітента (FR-035), а не операційний",
        "ключ платформи: підписи передаються в `remaining_accounts`."
      ],
      "discriminator": [
        40,
        133,
        12,
        157,
        235,
        202,
        2,
        132
      ],
      "accounts": [
        {
          "name": "issuerConfig",
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
                "kind": "account",
                "path": "issuer_config.issuer_id",
                "account": "issuerConfig"
              }
            ]
          }
        },
        {
          "name": "tokenConfig",
          "docs": [
            "Мусить іти перед `policy_config`: його `mint` є seed'ом наступного",
            "акаунта, а Anchor перевіряє поля в порядку оголошення."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "token_config.mint",
                "account": "tokenConfig"
              }
            ]
          }
        },
        {
          "name": "policyConfig",
          "docs": [
            "Нова версія. `init` тут і є незмінністю історії (FR-010): версія, яка вже",
            "існує, не створюється вдруге, а інструкції, що відкрила б її на запис, у",
            "програмі немає."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "token_config.mint",
                "account": "tokenConfig"
              },
              {
                "kind": "arg",
                "path": "args.version"
              }
            ]
          }
        },
        {
          "name": "payer",
          "docs": [
            "Хто платить оренду за нову версію. Повноважень цей підпис не дає — їх",
            "дає тільки кворум серед `remaining_accounts`."
          ],
          "writable": true,
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
              "name": "setPolicyArgs"
            }
          }
        }
      ]
    },
    {
      "name": "thawHolder",
      "docs": [
        "Розморожує рахунок холдера й заводить обидва акаунти, без яких переказ",
        "відмовляє: `HolderStatus` і `VelocityCounter` (FR-008b).",
        "",
        "Хук не створює акаунтів, тож їх створюють тут — наперед. Саме",
        "розморожування дозволом на переказ не є (FR-008b1): правила політики",
        "перевіряються на кожному переказі окремо."
      ],
      "discriminator": [
        56,
        60,
        31,
        119,
        186,
        131,
        171,
        109
      ],
      "accounts": [
        {
          "name": "issuerConfig",
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
                "kind": "account",
                "path": "issuer_config.issuer_id",
                "account": "issuerConfig"
              }
            ]
          }
        },
        {
          "name": "tokenConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "token_config.mint",
                "account": "tokenConfig"
              }
            ]
          }
        },
        {
          "name": "mint",
          "writable": true
        },
        {
          "name": "tokenAccount",
          "docs": [
            "Токен-акаунт холдера. Обидві перевірки обов'язкові: адреса акаунта не",
            "доводить ані його mint, ані власника, а статус виводиться саме з",
            "`wallet`."
          ],
          "writable": true
        },
        {
          "name": "holderStatus",
          "docs": [
            "`init_if_needed`, бо рахунок законно розморожують удруге — після",
            "заморозки офіцером. Повторне створення нічого не переписує: що саме",
            "пишеться, вирішує `updated_at`, а не наявність акаунта."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "token_config.mint",
                "account": "tokenConfig"
              },
              {
                "kind": "arg",
                "path": "args.wallet"
              }
            ]
          }
        },
        {
          "name": "velocityCounter",
          "docs": [
            "Так само `init_if_needed` — і **жодне поле лічильника тут не пишеться**,",
            "крім `bump`. Скидання вікна операційним ключем зняло б ліміт за період",
            "рутинною дією, тобто дало б повноваження, якого в масці делегації немає",
            "й не може бути (FR-035a)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  101,
                  108,
                  111,
                  99,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "token_config.mint",
                "account": "tokenConfig"
              },
              {
                "kind": "arg",
                "path": "args.wallet"
              }
            ]
          }
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "authority",
          "docs": [
            "Операційний ключ платформи або уповноважений учасник складу."
          ],
          "signer": true
        },
        {
          "name": "tokenProgram"
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
              "name": "thawHolderArgs"
            }
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "holderStatus",
      "discriminator": [
        67,
        242,
        217,
        54,
        237,
        58,
        108,
        127
      ]
    },
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
    },
    {
      "name": "policyConfig",
      "discriminator": [
        219,
        7,
        79,
        84,
        175,
        51,
        148,
        146
      ]
    },
    {
      "name": "tokenConfig",
      "discriminator": [
        92,
        73,
        255,
        43,
        107,
        51,
        117,
        101
      ]
    },
    {
      "name": "velocityCounter",
      "discriminator": [
        155,
        85,
        56,
        107,
        143,
        157,
        165,
        171
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
      "name": "unknownRuleKind",
      "msg": "policy carries a rule kind this version of the program does not know"
    },
    {
      "code": 6013,
      "name": "tooFewMembers",
      "msg": "issuer must have at least two members to reach a quorum"
    },
    {
      "code": 6014,
      "name": "tooManyMembers",
      "msg": "member list exceeds the fixed capacity"
    },
    {
      "code": 6015,
      "name": "duplicateMember",
      "msg": "the same wallet appears twice in the member list"
    },
    {
      "code": 6016,
      "name": "memberWithoutRole",
      "msg": "a member must hold at least one role"
    },
    {
      "code": 6017,
      "name": "unknownRole",
      "msg": "role mask contains a bit this program does not define"
    },
    {
      "code": 6018,
      "name": "attestorHoldsOtherRoles",
      "msg": "the reserve attestor may hold no other role"
    },
    {
      "code": 6019,
      "name": "quorumTooSmall",
      "msg": "quorum must be at least two"
    },
    {
      "code": 6020,
      "name": "quorumExceedsSigners",
      "msg": "quorum exceeds the number of members who may authorise actions"
    },
    {
      "code": 6021,
      "name": "notAnAdmin",
      "msg": "signer is not an administrator of this issuer"
    },
    {
      "code": 6022,
      "name": "undelegatablePower",
      "msg": "delegation mask contains a power that can never be delegated"
    },
    {
      "code": 6023,
      "name": "missingOperationalKey",
      "msg": "operational key must be a real address"
    },
    {
      "code": 6024,
      "name": "tokenNotFromThisIssuer",
      "msg": "token config does not belong to this issuer"
    },
    {
      "code": 6025,
      "name": "policyVersionNotNext",
      "msg": "policy version must be exactly one past the version this mint is on"
    },
    {
      "code": 6026,
      "name": "policyRulesNotCanonical",
      "msg": "rule slots are not in the single canonical form this program accepts"
    },
    {
      "code": 6027,
      "name": "policyRuleKindUnknown",
      "msg": "policy carries a rule kind this program does not define"
    },
    {
      "code": 6028,
      "name": "policyRuleParamsOutOfRange",
      "msg": "a rule parameter lies outside the range the model allows"
    },
    {
      "code": 6029,
      "name": "policyStatusRuleMissing",
      "msg": "a policy must carry the status rule"
    },
    {
      "code": 6030,
      "name": "notAnAuthorisingSigner",
      "msg": "signer is not a member who may authorise actions for this issuer"
    },
    {
      "code": 6031,
      "name": "duplicateApproval",
      "msg": "the same wallet approved twice"
    },
    {
      "code": 6032,
      "name": "quorumNotReached",
      "msg": "action did not reach the issuer's quorum"
    },
    {
      "code": 6033,
      "name": "powerNotDelegated",
      "msg": "this power is not delegated to the operational key"
    },
    {
      "code": 6034,
      "name": "notAnOperatorOrOfficer",
      "msg": "signer is neither the operational key nor an officer of this issuer"
    },
    {
      "code": 6035,
      "name": "holderJurisdictionInvalid",
      "msg": "jurisdiction must be an upper-case ISO 3166-1 alpha-2 code"
    },
    {
      "code": 6036,
      "name": "holderStatusAlreadyExpired",
      "msg": "a status that is already expired when written would read as absent"
    },
    {
      "code": 6037,
      "name": "holderStatusRequired",
      "msg": "the first thaw must carry the holder status"
    },
    {
      "code": 6038,
      "name": "holderStatusAlreadySet",
      "msg": "this holder already has a status; change it with set_holder_status"
    },
    {
      "code": 6039,
      "name": "holderAccountMismatch",
      "msg": "token account does not belong to this mint or to this wallet"
    }
  ],
  "types": [
    {
      "name": "holderStatus",
      "docs": [
        "Статус адреси у власному реєстрі емітента. PDA: `[\"holder\", mint, wallet]`.",
        "",
        "Це **одне з двох** джерел статусу (FR-008a); друге — атестація провайдера,",
        "яку хук читає напряму зі спільного сервісу атестацій (спайк T057).",
        "",
        "**Двох полів із `docs/PLAN.md` тут немає, і це свідомо:**",
        "- `source` (issuer/provider) був потрібен, поки статус провайдера планували",
        "дзеркалити сюди. T057 закрив це питання інакше — атестація читається",
        "напряму, — тож поле означало б «джерело цього запису в реєстрі емітента",
        "не емітент», чого не буває.",
        "- `thawed` був би другим джерелом правди про стан, який авторитетно тримає",
        "сам токен-акаунт (`DefaultAccountState`, `freeze_account`). Офіцер може",
        "заморозити рахунок (T026), не торкаючись цього акаунта, і прапорець тут",
        "одразу став би брехнею. Черга на розморожування (FR-008b2) живе офчейн.",
        "",
        "Через це `flags` звівся до одного значення й лишився `bool`: бітмаска на",
        "один біт — це маска, яку читають, звіряючись із коментарем."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "docs": [
              "Обидва поля дублюють seeds навмисно: консоль і індексатор шукають",
              "холдерів через `getProgramAccounts` із фільтром за mint, а зробити такий",
              "фільтр по seeds неможливо."
            ],
            "type": "pubkey"
          },
          {
            "name": "wallet",
            "type": "pubkey"
          },
          {
            "name": "tier",
            "docs": [
              "Рівень верифікації, як його присвоїв емітент."
            ],
            "type": "u8"
          },
          {
            "name": "jurisdiction",
            "docs": [
              "Код ISO 3166-1 alpha-2 у верхньому регістрі."
            ],
            "type": {
              "array": [
                "u8",
                2
              ]
            }
          },
          {
            "name": "denied",
            "docs": [
              "Заборона емітента. Діє **незалежно** від того, чи приймає політика це",
              "джерело (FR-008a1): власний реєстр звужує коло, дозволене провайдером, і",
              "ніколи його не розширює."
            ],
            "type": "bool"
          },
          {
            "name": "expiresAt",
            "docs": [
              "Строк придатності запису, unix-секунди. **Нуль означає «без строку»**, а",
              "не «протерміновано»: запис без строку — дійсний стан реєстру, і саме він",
              "відрізняє реєстр від атестації, яка строк має завжди."
            ],
            "type": "i64"
          },
          {
            "name": "updatedAt",
            "docs": [
              "Коли запис востаннє писали.",
              "",
              "Не декорація: **нуль тут означає «запису ще не було»**. Свіжостворений",
              "акаунт весь нульовий, а жоден справжній запис не має нульового часу",
              "блоку, тож `thaw_holder` за цим полем відрізняє перше розморожування від",
              "повторного — і не переписує статус, якого йому не доручали писати."
            ],
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "holderStatusInput",
      "docs": [
        "Значення статусу, які приносить інструкція.",
        "",
        "Окремий тип від акаунта: в акаунті є ще й `mint`, `wallet`, `bump` і",
        "`updated_at`, і жодне з них клієнт не задає."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "tier",
            "type": "u8"
          },
          {
            "name": "jurisdiction",
            "type": {
              "array": [
                "u8",
                2
              ]
            }
          },
          {
            "name": "denied",
            "type": "bool"
          },
          {
            "name": "expiresAt",
            "docs": [
              "Нуль — без строку."
            ],
            "type": "i64"
          }
        ]
      }
    },
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
    },
    {
      "name": "policyConfig",
      "docs": [
        "Версія політики. PDA: `[\"policy\", mint, version]`, версія — `u32` LE.",
        "",
        "**Незмінність історії — властивість адреси, а не перевірки в коді.** Кожна",
        "версія живе за власним PDA й створюється через `init`, тож повторний запис у",
        "вже існуючу версію відхиляє рантайм, а не наша логіка (FR-010). Перезаписати",
        "попередню версію нічим: інструкції, яка б відкрила її на запис, у програмі",
        "немає.",
        "",
        "`zero_copy`, бо хук читає `rules` на **кожному** переказі: десеріалізація",
        "Borsh 384 байтів у CU-бюджеті хука коштувала б дорожче за саму перевірку.",
        "Звідси `#[repr(C)]`, явна набивка до восьми байтів і `AccountLoader` замість",
        "`Account` на боці інструкцій."
      ],
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "activatedAt",
            "docs": [
              "Час активації, unix-секунди — половина того, чого вимагає FR-010."
            ],
            "type": "i64"
          },
          {
            "name": "version",
            "type": "u32"
          },
          {
            "name": "author",
            "docs": [
              "Хто ініціював зміну — перший підпис із зібраного кворуму.",
              "",
              "Поіменний склад усіх, хто санкціонував дію (FR-019c), тут не лежить",
              "навмисно: він належить журналу й `ActionProposal` (T025, T029), а",
              "шістнадцять адрес у кожній версії політики були б третім дзеркалом того",
              "самого факту."
            ],
            "type": "pubkey"
          },
          {
            "name": "rules",
            "docs": [
              "Правила у канонічній розкладці. Порядок і межі тримає `rules::layout`."
            ],
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "ruleSlot"
                  }
                },
                16
              ]
            }
          },
          {
            "name": "rulesHash",
            "docs": [
              "sha256 над усім полем `rules`, порахований програмою при записі.",
              "",
              "Рахується тут, а не приймається від клієнта: хеш, який приніс той самий,",
              "хто приніс байти, доводить лише те, що клієнт уміє рахувати хеші."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "padding",
            "docs": [
              "Явна набивка до вирівнювання 8. Без неї `bytemuck::Pod` не виводиться, а",
              "мовчазна набивка компілятора потрапила б у хеш акаунта як сміття."
            ],
            "type": {
              "array": [
                "u8",
                3
              ]
            }
          }
        ]
      }
    },
    {
      "name": "ruleSlot",
      "docs": [
        "Один слот правила, як він лежить в акаунті."
      ],
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "kind",
            "type": "u8"
          },
          {
            "name": "op",
            "type": "u8"
          },
          {
            "name": "params",
            "type": {
              "array": [
                "u8",
                22
              ]
            }
          }
        ]
      }
    },
    {
      "name": "setHolderStatusArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "wallet",
            "type": "pubkey"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "holderStatusInput"
              }
            }
          }
        ]
      }
    },
    {
      "name": "setPolicyArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "docs": [
              "Номер нової версії. Мусить бути рівно наступним за чинною: пропуск",
              "зробив би «попередню версію» невиводимою з номера, а історію — переліком",
              "з дірками, який нічим не звірити."
            ],
            "type": "u32"
          },
          {
            "name": "rules",
            "docs": [
              "Правила в канонічній розкладці, рівно `RULES_BYTES` байтів.",
              "",
              "`Vec<u8>`, а не масив: Borsh описує його як `bytes`, і IDL лишається",
              "читабельним для клієнта. Довжину перевіряє програма."
            ],
            "type": "bytes"
          }
        ]
      }
    },
    {
      "name": "thawHolderArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "wallet",
            "docs": [
              "Власник рахунку. Мусить збігтися з `owner` токен-акаунта — інакше",
              "статус ліг би за адресою, якої переказ ніколи не прочитає."
            ],
            "type": "pubkey"
          },
          {
            "name": "status",
            "docs": [
              "Початковий статус — тільки для **першого** розморожування.",
              "",
              "`None` означає «запис уже є, я його не чіпаю»: так виглядає повторне",
              "розморожування після заморозки офіцером (T026). Розбіжність між",
              "наміром і станом акаунта відхиляється, а не тлумачиться, тож жоден",
              "виклик не змінює статусу мовчки."
            ],
            "type": {
              "option": {
                "defined": {
                  "name": "holderStatusInput"
                }
              }
            }
          }
        ]
      }
    },
    {
      "name": "tokenConfig",
      "docs": [
        "Конфігурація випущеного токена. PDA: `[\"token\", mint]`.",
        "",
        "**Порядок полів тут — частина протоколу, а не стиль.** Хук отримує акаунт",
        "атестації провайдера через `ExtraAccountMetaList`, а її адреса виводиться з",
        "seeds `[\"attestation\", credential, schema, nonce]` (спайк T057). Два",
        "32-байтові літерали в 32-байтовий `address_config` не вміщаються ніколи, тож",
        "`credential` і `schema` беруться **зрізами даних цього акаунта** — а зсув у",
        "seed `AccountData` має розмір рівно одного байта.",
        "",
        "Звідси два обмеження, які тепер є вимогами до розкладки:",
        "- обидва поля мусять лежати в перших 256 байтах акаунта;",
        "- їхні зсуви зашиті в `address_config` уже створених `ExtraAccountMetaList`,",
        "тож вставка нового поля **перед ними** мовчки перенаправить хук на чужі",
        "32 байти. Тест `token_config_offsets_are_pinned` існує саме проти цього."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "issuer",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "attestationCredential",
            "docs": [
              "SAS-credential провайдера верифікації, атестації якого приймає цей токен."
            ],
            "type": "pubkey"
          },
          {
            "name": "attestationSchema",
            "docs": [
              "SAS-schema тих атестацій."
            ],
            "type": "pubkey"
          },
          {
            "name": "attestor",
            "docs": [
              "Чинний атестатор резерву **цього токена** (FR-024b).",
              "",
              "Живе тут, а не в `IssuerConfig`, попри `docs/PLAN.md`: FR-024b перевіряє",
              "підпис проти атестатора конкретного токена, і емітент із двома токенами",
              "законно має для них різних атестаторів."
            ],
            "type": "pubkey"
          },
          {
            "name": "treasury",
            "docs": [
              "Скарбниця платформи: сюди йде комісія з емісії й погашення (FR-038)."
            ],
            "type": "pubkey"
          },
          {
            "name": "policyVersion",
            "docs": [
              "Версія політики, на яку налаштований mint. Розбіжність — перша перевірка",
              "хука й перший код відмови."
            ],
            "type": "u32"
          },
          {
            "name": "feeBps",
            "docs": [
              "Оголошена ставка комісії (FR-038a)."
            ],
            "type": "u16"
          },
          {
            "name": "attestationMaxAge",
            "docs": [
              "Строк придатності атестації, секунди (FR-023b)."
            ],
            "type": "i64"
          },
          {
            "name": "pausedAt",
            "docs": [
              "Дзеркало стану паузи для журналу й екранів; `0` — не на паузі.",
              "Авторитетним лишається розширення `Pausable` на самому mint (FR-016)."
            ],
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "velocityCounter",
      "docs": [
        "Лічильник ліміту за період. PDA: `[\"velocity\", mint, wallet]`.",
        "",
        "`mint` і `wallet` тут **не** дублюються, на відміну від `HolderStatus`:",
        "лічильник читає тільки хук, за виведеною адресою, і жодного сканування за",
        "фільтром по ньому не буває. Зайві 64 байти на кожного холдера — це оренда,",
        "яку платить емітент."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "windowStart",
            "docs": [
              "Початок поточного вікна. Нуль означає, що вікна ще не було."
            ],
            "type": "i64"
          },
          {
            "name": "spentInWindow",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    }
  ]
}
