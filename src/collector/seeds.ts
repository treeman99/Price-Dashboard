import type { CreateProductInput } from "../../shared/types.ts";

/**
 * 폴백 시드 8종. 기존 price_history.json 임포트가 우선이며,
 * 임포트에 없는 시드 상품만 모델 매칭 규칙과 함께 보강 등록한다.
 *
 * mustInclude: AND of OR-groups (모든 그룹에서 1개 이상 포함되어야 통과)
 * mustExclude: 이 상품 전용 추가 제외어 (전역 제외어는 filters.ts)
 */
export const SEED_PRODUCTS: CreateProductInput[] = [
  {
    name: "리코 GR4",
    mustInclude: [["GR4", "GRIV", "GR IV"]],
    mustExclude: [],
    minPrice: 500_000,
  },
  {
    name: "DJI 오즈모 포켓4",
    mustInclude: [["Pocket 4", "Pocket4", "포켓 4", "포켓4"]],
    mustExclude: ["Pro", "프로", "Pocket 3", "Pocket3", "포켓 3", "포켓3", "Pocket 2", "Pocket2", "Action", "액션"],
    minPrice: 300_000,
  },
  {
    name: "DJI 오즈모 포켓4 프로",
    mustInclude: [
      ["Pocket 4", "Pocket4", "포켓 4", "포켓4"],
      ["Pro", "프로"],
    ],
    mustExclude: ["Pocket 3", "Pocket3", "포켓 3", "포켓3", "Pocket 2", "Pocket2", "Action", "액션"],
    minPrice: 400_000,
  },
  {
    name: "인스타360 루나 울트라",
    mustInclude: [
      ["루나", "Luna"],
      ["울트라", "Ultra"],
    ],
    mustExclude: ["Pro", "프로"],
    minPrice: 800_000,
  },
  {
    name: "인스타360 루나 프로",
    mustInclude: [
      ["루나", "Luna"],
      ["프로", "Pro"],
    ],
    mustExclude: ["울트라", "Ultra"],
    minPrice: 600_000,
  },
  {
    name: "로보락 S10 MaxV Ultra",
    mustInclude: [
      ["S10"],
      ["MaxV", "맥스V", "맥스 V"],
      ["Ultra", "울트라"],
    ],
    mustExclude: ["Slim", "슬림", "S8", "S7", "Qrevo", "큐레보", "Saros", "사로스"],
    minPrice: 800_000,
  },
  {
    name: "로보락 S10 MaxV Slim",
    mustInclude: [
      ["S10"],
      ["MaxV", "맥스V", "맥스 V"],
      ["Slim", "슬림"],
    ],
    mustExclude: ["Ultra", "울트라", "S8", "S7", "Qrevo", "큐레보", "Saros", "사로스"],
    minPrice: 500_000,
  },
  {
    name: "드리미 X60 Ultra",
    mustInclude: [
      ["X60"],
      ["Ultra", "울트라"],
    ],
    mustExclude: ["X50", "X40", "X30", "X60 Pro", "X60Pro", "L40", "L30"],
    minPrice: 700_000,
  },
];

/** 이름으로 시드 매칭 규칙 조회 (임포트 시 과거 상품에 규칙 부여용) */
export function findSeedByName(name: string): CreateProductInput | undefined {
  return SEED_PRODUCTS.find((s) => s.name === name);
}
