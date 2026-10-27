mod access;
mod password;
mod rank;
mod title;

pub use access::{assert_board_access, AccessError};
pub use password::{hash_password, verify_password, PasswordError};
pub use rank::{
    move_card, rebalance_ranks, MoveCard, MoveError, RankInsert, RANK_GAP,
};
pub use title::{validate_title, TitleError};

use ts_rs::TS;

#[derive(Clone, Debug, PartialEq, Eq, TS)]
pub struct Board {
    pub id: String,
    pub title: String,
    pub archived: bool,
    pub owner_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, TS)]
pub struct List {
    pub id: String,
    pub board_id: String,
    pub title: String,
    pub rank: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, TS)]
pub struct Card {
    pub id: String,
    pub board_id: String,
    pub list_id: String,
    pub title: String,
    pub description: String,
    pub rank: i64,
}
