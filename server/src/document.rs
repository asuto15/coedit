use crate::types::{Edit, OpKind};

#[derive(Debug, Default)]
pub struct Doc {
    pub rev: u64,
    pub content: String,
    pub log: Vec<Vec<OpKind>>,
    pub since_flush: usize,
    pub password_hash: Option<String>,
}

pub fn transform_ops(doc: &Doc, edit: &Edit) -> Vec<OpKind> {
    let mut ops = edit.ops.clone();
    if edit.base_rev >= doc.rev {
        return ops;
    }
    let from = edit.base_rev as usize;
    let to = doc.rev as usize;
    for i in from..to {
        if let Some(prev_ops) = doc.log.get(i) {
            ops = transform_against(&ops, prev_ops);
        }
    }
    ops
}

fn transform_against(ops: &[OpKind], prev: &[OpKind]) -> Vec<OpKind> {
    let mut res = ops.to_vec();
    for p in prev {
        res = res.into_iter().map(|o| transform_op(o, p)).collect();
    }
    res
}

fn transform_op(op: OpKind, other: &OpKind) -> OpKind {
    match (op, other) {
        (OpKind::Insert { mut pos, text }, OpKind::Insert { pos: o, text: t }) => {
            if pos > *o {
                pos += t.chars().count();
            }
            OpKind::Insert { pos, text }
        }
        (OpKind::Insert { mut pos, text }, OpKind::Delete { pos: o, len }) => {
            if pos > *o {
                pos = pos.saturating_sub(*len);
            }
            OpKind::Insert { pos, text }
        }
        (OpKind::Delete { mut pos, len }, OpKind::Insert { pos: o, text: t }) => {
            if pos >= *o {
                pos += t.chars().count();
            }
            OpKind::Delete { pos, len }
        }
        (OpKind::Delete { mut pos, len }, OpKind::Delete { pos: o, len: l }) => {
            if pos >= *o {
                pos = pos.saturating_sub(*l);
            }
            OpKind::Delete { pos, len }
        }
    }
}

pub fn apply_ops(doc: &mut Doc, ops: &[OpKind]) {
    for op in ops {
        match op {
            OpKind::Insert { pos, .. } if *pos > doc.content.chars().count() => {
                continue;
            }
            _ => {}
        }
        apply_single_op(doc, op);
    }
}

fn apply_single_op(doc: &mut Doc, op: &OpKind) {
    match op {
        OpKind::Insert { pos, text } => {
            let mut s = String::new();
            let mut it = doc.content.chars();
            for _ in 0..*pos {
                if let Some(c) = it.next() {
                    s.push(c);
                }
            }
            s.push_str(text);
            for c in it {
                s.push(c);
            }
            doc.content = s;
        }
        OpKind::Delete { pos, len } => {
            let mut s = String::new();
            let mut it = doc.content.chars();
            for _ in 0..*pos {
                if let Some(c) = it.next() {
                    s.push(c);
                }
            }
            for _ in 0..*len {
                let _ = it.next();
            }
            for c in it {
                s.push(c);
            }
            doc.content = s;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Edit, OpKind};

    #[test]
    fn transform_ops_accounts_for_previous_inserts() {
        let prior = OpKind::Insert {
            pos: 0,
            text: "abc".into(),
        };
        let doc = Doc {
            rev: 1,
            content: "abc".into(),
            log: vec![vec![prior]],
            ..Default::default()
        };
        let edit = Edit {
            base_rev: 0,
            ops: vec![OpKind::Insert {
                pos: 1,
                text: "X".into(),
            }],
            client_id: None,
            op_id: None,
            cursor_before: None,
            cursor_after: None,
            ts: None,
        };

        let transformed = transform_ops(&doc, &edit);

        assert_eq!(
            transformed,
            vec![OpKind::Insert {
                pos: 4,
                text: "X".into()
            }]
        );
    }

    #[test]
    fn apply_ops_deletes_and_inserts_characters() {
        let mut doc = Doc {
            content: "abcdef".into(),
            ..Default::default()
        };

        apply_ops(
            &mut doc,
            &[
                OpKind::Delete { pos: 2, len: 2 },
                OpKind::Insert {
                    pos: 2,
                    text: "XY".into(),
                },
            ],
        );

        assert_eq!(doc.content, "abXYef");
    }
}
