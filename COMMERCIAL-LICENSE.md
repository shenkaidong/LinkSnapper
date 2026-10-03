# 商业授权说明（Commercial License）

> 这不是法律意见。需要具有法律约束力的条款时，请让你的法务出一份正式合同。

## 一句话

**代码永远是 MIT，免费，可商用，不需要向我们付钱，也不需要告诉我们。**
付费买的是代码之外的东西：托管、支持响应、SLA、企业功能与商标授权。

## 1. MIT 覆盖了什么

仓库根目录的 [LICENSE](./LICENSE) 是标准的 MIT 许可，覆盖本仓库的全部源代码。
在 MIT 条款下你可以：

- 个人、商业、内部使用，免费，无时间限制；
- 自行部署任意数量的实例（含内网、离线环境）；
- 修改、二次开发、嵌入到你自己的产品里（含闭源商业产品）；
- 分发副本。

唯一的实质义务是保留版权声明与许可声明。

**这一点不会因为任何后续版本而改变。** 已经以 MIT 发布的代码，其许可不可撤销。
即便将来新增了商业专属功能，MIT 部分仍然是 MIT。

## 2. MIT 不覆盖什么

| 项目 | 说明 |
| --- | --- |
| **商标** | 名称「LinkSnapper」与项目 Logo **不在** MIT 授权范围内。你可以说"基于 LinkSnapper 构建"，但不能把你的产品、服务或公司命名为 LinkSnapper，也不能用本项目 Logo 暗示官方背书。 |
| **官方身份** | MIT 不授予你宣称自己是本项目官方、官方合作方或官方发行版的权利。 |
| **托管服务** | 我们不提供免费的公共实例。`ghcr.io/...` 上分发的是容器镜像，由你自己运行。 |
| **担保与赔偿** | MIT 明确免除一切担保与责任。需要担保、赔偿条款或安全合规材料的，走商业授权。 |

## 3. 商业授权包含什么

商业授权是**叠加**在 MIT 之上的，不会削弱你已经拥有的 MIT 权利。可选内容：

1. **托管版** —— 我们运维，你拿 API key。省掉浏览器池、扩容、监控这些运维负担。
2. **支持与 SLA** —— 响应时间承诺、故障分级、优先修复、升级兼容性保证。
3. **企业功能** —— 多租户与配额计费、SSO / 审计日志导出、安全评估与合规材料、
   自定义部署形态（私有云 / 离线镜像 / Helm chart）。
4. **商标授权** —— 允许在产品名、市场材料中使用 LinkSnapper 名称。
5. **担保与赔偿** —— MIT 不提供的那部分法律保护。

按年订阅或按用量计费，具体以合同为准。

## 4. 谁不需要付费

- 个人、学生、开源项目、内部工具 —— 直接用 MIT，不用联系我们。
- 自建自运维、不需要 SLA 的公司 —— 同样直接用 MIT，这是被鼓励的用法。
- 只是想试一下 —— 拉镜像跑起来就行。

## 5. 谁应该考虑付费

- 法务不接受"仅有 MIT、无担保无赔偿"的采购流程；
- 需要有人为线上故障负责，而不是自己盯着 Chromium 崩溃；
- 需要多租户、配额计费、SSO 这类企业功能，且不想自己维护分支；
- 想把 LinkSnapper 的名字用在自己的对外产品上。

## 6. 联系

- 一般用途不需要联系，直接按 MIT 用即可。
- 商业咨询：请在仓库开一个 Discussion，或发邮件到 `<!-- TODO: 填入商业咨询邮箱 -->`。

> 发布前请把上面这行的 TODO 替换成真实联系方式，否则这一节等于没有出口。

---

# Commercial License (English summary)

The code in this repository is licensed under the **MIT License** — free for any use,
including commercial, self-hosted, and closed-source embedding. That grant is
irrevocable and will not change in future releases.

What MIT does **not** grant:

- the **"LinkSnapper" trademark and logo** (you may say "built on LinkSnapper",
  but you may not name your product or company LinkSnapper, or imply endorsement);
- any warranty, indemnification, or support commitment;
- a hosted service — we ship container images, you run them.

A commercial license is **additive** on top of MIT and never reduces your MIT rights.
It covers managed hosting, SLA and support response times, enterprise features
(multi-tenancy, quota billing, SSO, audit export, compliance documentation),
trademark use, and warranty/indemnification.

If you are an individual, a student, an open-source project, or a company happy to
self-host without an SLA: just use it under MIT. No payment, no need to contact us.
