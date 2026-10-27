use thiserror::Error;

pub const RANK_GAP: i64 = 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RankInsert {
    Rank(i64),
    NeedsRebalance,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MoveCard {
    pub rank: i64,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum MoveError {
    #[error("並びの再計算が必要です")]
    NeedsRebalance,
    #[error("隣の順位が逆です")]
    InvertedNeighbors,
}

pub fn rank_for_insert(prev: Option<i64>, next: Option<i64>) -> RankInsert {
    match (prev, next) {
        (None, None) => RankInsert::Rank(0),
        (Some(prev), None) => RankInsert::Rank(prev.saturating_add(RANK_GAP)),
        (None, Some(next)) => RankInsert::Rank(next.saturating_sub(RANK_GAP)),
        (Some(prev), Some(next)) if next <= prev => RankInsert::NeedsRebalance,
        (Some(prev), Some(next)) if next - prev <= 1 => RankInsert::NeedsRebalance,
        (Some(prev), Some(next)) => RankInsert::Rank(prev + (next - prev) / 2),
    }
}

pub fn rebalance_ranks(count: usize) -> Vec<i64> {
    (0..count).map(|i| i as i64 * RANK_GAP).collect()
}

pub fn move_card(prev: Option<i64>, next: Option<i64>) -> Result<MoveCard, MoveError> {
    match rank_for_insert(prev, next) {
        RankInsert::Rank(rank) => Ok(MoveCard { rank }),
        RankInsert::NeedsRebalance => {
            if matches!((prev, next), (Some(p), Some(n)) if n < p) {
                Err(MoveError::InvertedNeighbors)
            } else {
                Err(MoveError::NeedsRebalance)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_card_is_zero() {
        assert_eq!(rank_for_insert(None, None), RankInsert::Rank(0));
    }

    #[test]
    fn append_adds_gap() {
        assert_eq!(rank_for_insert(Some(0), None), RankInsert::Rank(RANK_GAP));
    }

    #[test]
    fn prepend_subtracts_gap() {
        assert_eq!(
            rank_for_insert(None, Some(0)),
            RankInsert::Rank(-RANK_GAP)
        );
    }

    #[test]
    fn between_takes_midpoint() {
        assert_eq!(
            rank_for_insert(Some(0), Some(RANK_GAP)),
            RankInsert::Rank(RANK_GAP / 2)
        );
    }

    #[test]
    fn adjacent_integers_need_rebalance() {
        assert_eq!(rank_for_insert(Some(3), Some(4)), RankInsert::NeedsRebalance);
        assert_eq!(move_card(Some(3), Some(4)), Err(MoveError::NeedsRebalance));
    }

    #[test]
    fn inverted_neighbors_are_an_error() {
        assert_eq!(
            move_card(Some(10), Some(2)),
            Err(MoveError::InvertedNeighbors)
        );
    }

    #[test]
    fn rebalance_ranks_spreads_by_gap() {
        assert_eq!(rebalance_ranks(3), vec![0, RANK_GAP, RANK_GAP * 2]);
        assert_eq!(rebalance_ranks(0), Vec::<i64>::new());
    }

    #[test]
    fn move_card_returns_new_rank() {
        assert_eq!(move_card(Some(0), Some(10)), Ok(MoveCard { rank: 5 }));
    }
}
