# 商业授权说明（Commercial License）

> 这不是法律意见。需要具有法律约束力的条款时，请让你的法务出一份正式合同。

## 一句话

**开源代码永远是 Apache-2.0，免费，可商用，不需要向我们付钱，也不需要告诉我们。**
付费买的是代码之外的东西：托管、支持响应、SLA、企业功能与商标授权。

## 1. Apache-2.0 覆盖了什么

仓库根目录的 [LICENSE](./LICENSE) 是标准 Apache License 2.0，[NOTICE](./NOTICE) 是配套声明，
覆盖本仓库的全部源代码。在 Apache-2.0 条款下你可以：

- 个人、商业、内部使用，免费，无时间限制；
- 自行部署任意数量的实例（含内网、离线环境）；
- 修改、二次开发、嵌入到你自己的产品里（含闭源商业产品）；
- 分发副本，包括收费分发（Apache-2.0 从不允许对"运行中的服务"收费限制，
  它只要求你在分发的副本里带上许可证与 NOTICE）。

义务只有三条，都很轻：

1. 保留 LICENSE 与 NOTICE；
2. 在你修改过的文件上标注改动（Section 4(b)）；
3. 不使用本项目的商标表示背书。

另外 Apache-2.0 自带一条**明确专利授权**：每个贡献者都授予你其相关专利，
你若就本项目发起专利诉讼，该授权自动终止。MIT 没有这一条 —— 这是本项目从 MIT
换到 Apache-2.0 的唯一实质原因：对采购流程严谨的企业，有 patent grant 能少一轮法务往返。

**这一点不会因为任何后续版本而改变。** 已经以 Apache-2.0 发布的代码，其许可不可撤销。
即便将来新增了商业专属功能，开源部分仍然是 Apache-2.0。

## 2. Apache-2.0 不覆盖什么

| 项目 | 说明 |
| --- | --- |
| **商标** | 名称「LinkSnapper」与项目 Logo **不在** Apache-2.0 授权范围内。你可以说"基于 LinkSnapper 构建"，但不能把你的产品、服务或公司命名为 LinkSnapper，也不能用本项目 Logo 暗示官方背书。 |
| **官方身份** | 开源许可不授予你宣称自己是本项目官方、官方合作方或官方发行版的权利。 |
| **托管服务** | 我们不提供免费的公共实例。`ghcr.io/...` 上分发的是容器镜像，由你自己运行。 |
| **担保与赔偿** | Apache-2.0 明确免除一切担保与责任。需要担保、赔偿条款或安全合规材料的，走商业授权。 |

## 3. 商业授权包含什么

商业授权是**叠加**在开源许可之上的，不会削弱你已经拥有的开源权利。可选内容：

1. **托管版** —— 我们运维，你拿 API key。省掉浏览器池、扩容、监控这些运维负担。
2. **支持与 SLA** —— 响应时间承诺、故障分级、优先修复、升级兼容性保证。
3. **企业功能** —— 多租户与配额计费、SSO / 审计日志导出、安全评估与合规材料、
   自定义部署形态（私有云 / 离线镜像 / Helm chart）。
4. **商标授权** —— 允许在产品名、市场材料中使用 LinkSnapper 名称。
5. **担保与赔偿** —— 开源许可不提供的那部分法律保护。

按年订阅或按用量计费，具体以合同为准。

> **当前实现状态（2026-10）**：上面第 1、2、4 项可以直接买；第 3 项里的
> 多租户 / 配额计费 / SSO / 审计导出**目前尚未实现**，属于企业版路线图。
> 采购前请确认哪些功能已经落地，别为一个占位键付钱。

## 4. 谁不需要付费

- 个人、学生、开源项目、内部工具 —— 直接用 Apache-2.0，不用联系我们。
- 自建自运维、不需要 SLA 的公司 —— 同样直接用开源许可，这是被鼓励的用法。
- 只是想试一下 —— 拉镜像跑起来就行。

## 5. 谁应该考虑付费

- 法务不接受"仅有开源许可、无担保无赔偿"的采购流程；
- 需要有人为线上故障负责，而不是自己盯着 Chromium 崩溃；
- 需要多租户、配额计费、SSO 这类企业功能，且不想自己维护分支；
- 想把 LinkSnapper 的名字用在自己的对外产品上。

## 6. 联系

- 一般用途不需要联系，直接按 Apache-2.0 用即可。
- 报问题：提 Issue 或开 Discussion，公开渠道通常比邮件更快。
- 商业咨询：开 Discussion 并标注 `[commercial]`，或发邮件到下面这行
  （**发布前请把 `<!-- TODO -->` 去掉并替换成真实邮箱**，否则这一节等于没有出口）：

  `<!-- TODO: 填入商业咨询邮箱 -->`

---

# Commercial License (English summary)

The open-source code in this repository is licensed under the **Apache License 2.0**
([LICENSE](./LICENSE), [NOTICE](./NOTICE)) — free for any use, including commercial,
self-hosted, and closed-source embedding. That grant is irrevocable and will not change
in future releases.

What Apache-2.0 does **not** grant:

- the **"LinkSnapper" trademark and logo** (you may say "built on LinkSnapper",
  but you may not name your product or company LinkSnapper, or imply endorsement);
- any warranty, indemnification, or support commitment;
- a hosted service — we ship container images, you run them.

Apache-2.0 adds, versus MIT, an express **patent grant** plus a NOTICE attribution duty.
Both are why we moved off MIT; your practical rights (self-host, embed, close the source)
are unchanged.

A commercial license is **additive** on top of Apache-2.0 and never reduces your
open-source rights. It covers managed hosting, SLA and support response times, trademark
use, and warranty/indemnification. Enterprise features (multi-tenancy, quota billing,
SSO, audit export, compliance documentation) are on the roadmap, not shipped today —
confirm what is actually delivered before buying.

If you are an individual, a student, an open-source project, or a company happy to
self-host without an SLA: just use it under Apache-2.0. No payment, no need to contact us.
