#!/usr/bin/env python3
"""Build the seeded food catalog from USDA SR Legacy.

The catalog that `GET /v1/nutrition/catalog` searches is version-controlled
JSON, exactly like `exercises.json` and `techniques.json`. This script is how
that JSON is produced, and it is the only thing that may write it by hand.

# Why SR Legacy, and why a file rather than the API

The FoodData Central *API* is not usable for this. `DEMO_KEY` is rate limited
to **10 requests an hour** (measured, `x-ratelimit-limit: 10`), SR Legacy is
7,793 foods, and resolving a few hundred by search would need a few hundred
requests. Worse, search results are not stable over time, so a catalog built
from live queries could not be rebuilt identically tomorrow.

The bulk download has neither problem. It needs **no API key**, and SR Legacy
is **frozen at 2018-04** — a released, superseded dataset that will never
change under us. So this build is reproducible forever:

    curl -O https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_json_2018-04.zip
    unzip FoodData_Central_sr_legacy_food_json_2018-04.zip
    python3 scripts/import_usda_foods.py build \\
        --source FoodData_Central_sr_legacy_food_json_2018-04.json

The 13 MB zip is deliberately NOT committed. It expands to 210 MB, and the
143 KB of JSON this produces is the part anyone needs to review.

**SR Legacy is US Government work and not subject to copyright** — public
domain, no attribution requirement and no share-alike. That is the whole
reason it is the seeded catalog rather than Open Food Facts, which is ODbL:
see the comment on `nutrition_foods.source` in migration 000059, which says an
ODbL obligation "must never reach our own data". Open Food Facts is used for
barcode lookups only, cached in its own table, and never seeded here.

# Why a hand-curated spec and not "import everything"

7,793 rows would make search worse, not better. SR Legacy's relevance is poor
on its own terms — searching the API for "chicken breast" returns *"Lunchmeat,
chicken breast, sliced"* first — and the long tail is baby food, school lunches
and branded fast food. An athlete logging dinner wants one row for chicken
breast, not forty.

So SPEC below names the foods a person actually logs, and each entry resolves
to exactly one SR Legacy row by include/exclude terms. The resolution is
**pinned into the output** as `external_id`, so the committed JSON records
which row every number came from and a reviewer can check any of them.

`--check` rebuilds and diffs against the committed file. It **exits non-zero**
on drift, because a checker that only reports is one nobody notices.

Stdlib only, per the convention for `scripts/*.py`: `verify` runs `check:python`
which only parses, so this must never need a toolchain to be syntax-checked.
"""

import argparse
import json
import os
import sys

# Nutrients we store, by USDA nutrient id.
#
# Widened by N52 from five to nine: the athlete asked for "all other that are
# important" and the panel they showed names Total Fat, Sat Fat, Cholesterol,
# Sodium, Total Carbs, Fiber, Sugars, Protein. The rule this list follows has
# not changed — a nutrient is imported only when something reads it — which is
# why vitamins are still absent.
#
# **1093 (sodium) is reported by USDA in MILLIGRAMS**, which is what
# `food_catalog.sodium_mg` stores, so no conversion happens here. Open Food
# Facts sends GRAMS for the same quantity and converts at its own boundary; see
# `sodiumMGFromGrams` in backend/internal/modules/food/barcode.go. Getting that
# backwards is a 1000x error that looks entirely plausible on a screen.
#
# **Added sugars (1235) is deliberately NOT here.** SR Legacy does not carry
# it — measured against the live FDC API on a real entry — so listing it would
# read as an import that silently never fires. Open Food Facts does carry it,
# so the column is populated for scanned products and null for every generic.
NUTRIENTS = {
    1008: "kcal",
    1003: "protein_g",
    1005: "carb_g",
    1004: "fat_g",
    1079: "fibre_g",
    1258: "saturated_fat_g",   # Fatty acids, total saturated (g)
    2000: "sugar_g",           # Sugars, total including NLEA (g)
    1093: "sodium_mg",         # Sodium, Na (MILLIGRAMS)
    1253: "cholesterol_mg",    # Cholesterol (MILLIGRAMS)
}

# The nutrients that stay NULL when the source does not state them, rather than
# defaulting to 0.
#
# A source that does not state sodium is not claiming there is none, and a zero
# would be a claim about the food where a null is a statement about our
# knowledge. This is the most-repeated defect in this codebase and it is on the
# exact panel the athlete showed us, so it is a list rather than four separate
# conditionals that can drift.
NULLABLE_NUTRIENTS = ("fibre_g", "saturated_fat_g", "sugar_g",
                      "sodium_mg", "cholesterol_mg")

# Every value in SR Legacy is per 100 g of the edible portion, so every row
# this writes is per 100 g and the module sets serving_label '100 g' for all of
# them. Household portions ("1 medium banana, 118 g") DO exist in the source
# and are deliberately not imported yet — see the known gap in the history
# entry. Storing one serving per food is what `nutrition_foods` already does.
SERVING_GRAMS = 100

# The market these numbers describe. USDA is a US dataset and the athletes are
# US-primarily, so 'us' is on evidence rather than as a default nobody chose.
# It is a column so that "we do not stock this food" and "we do not cover your
# region" stay different answers later without a migration.
MARKET = "us"

SPEC = [
 # ---- poultry
 ("chicken-breast","Chicken breast","poultry",["chicken","breast","skinless","meat only","raw"],["added"],["chicken"]),
 ("chicken-thigh","Chicken thigh","poultry",["chicken","thigh","meat only","raw"],["skin"],[]),
 ("chicken-ground","Ground chicken","poultry",["chicken","ground","raw"],["skin"],["chicken mince"]),
 ("chicken-breast-roasted","Chicken breast, roasted","poultry",["chicken","breast","meat only","roasted"],["skin"],[]),
 ("turkey-breast","Turkey breast","poultry",["turkey","breast","meat only","raw"],["skin"],[]),
 ("turkey-ground","Ground turkey","poultry",["turkey","ground","raw"],[],["turkey mince"]),
 ("chicken-wing","Chicken wing","poultry",["chicken","wing","meat only","raw"],["skin"],[]),
 ("duck-breast","Duck breast","poultry",["duck","breast","meat only","raw"],["skin"],[]),
 # ---- red meat
 ("beef-ground-90","Ground beef, 90% lean","red_meat",["beef, ground, 90%","raw"],[],["beef mince"]),
 ("beef-ground-80","Ground beef, 80% lean","red_meat",["beef, ground, 80%","raw"],[],[]),
 ("beef-ground-95","Ground beef, 95% lean","red_meat",["beef, ground, 95%","raw"],[],[]),
 ("beef-sirloin","Beef sirloin steak","red_meat",["beef","top sirloin","separable lean only","choice","raw"],["ground"],["sirloin"]),
 ("beef-ribeye","Beef ribeye steak","red_meat",["beef","rib eye","separable lean only","raw"],[],["ribeye"]),
 ("beef-tenderloin","Beef tenderloin","red_meat",["beef","tenderloin","separable lean only","raw"],[],["filet mignon"]),
 ("beef-chuck","Beef chuck roast","red_meat",["beef","chuck","separable lean only","raw"],[],[]),
 ("lamb-loin","Lamb loin","red_meat",["lamb","loin","separable lean only","raw"],[],[]),
 ("venison","Venison","red_meat",["game meat","deer","raw"],[],["deer"]),
 ("bison-ground","Ground bison","red_meat",["bison","ground","raw"],[],["buffalo"]),
 # ---- pork
 ("pork-loin","Pork loin chop","pork",["pork","loin","separable lean only","raw"],["ground"],["pork chop"]),
 ("pork-tenderloin","Pork tenderloin","pork",["pork","tenderloin","separable lean only","raw"],[],[]),
 ("pork-ground","Ground pork","pork",["pork","ground","raw"],[],[]),
 ("bacon","Bacon","pork",["pork","bacon","cooked"],["canadian","turkey","rendered"],[]),
 ("ham","Ham","pork",["ham","sliced","regular"],["turkey","spread"],[]),
 # ---- seafood
 ("salmon-atlantic","Salmon, Atlantic","seafood",["salmon","atlantic","farmed","raw"],[],["salmon"]),
 ("salmon-sockeye","Salmon, sockeye","seafood",["salmon","sockeye","raw"],[],[]),
 ("tuna-canned","Tuna, canned in water","seafood",["tuna","light","canned in water","drained"],[],["canned tuna"]),
 ("tuna-yellowfin","Tuna, yellowfin","seafood",["tuna","yellowfin","raw"],[],["ahi"]),
 ("cod","Cod","seafood",["fish","cod","atlantic","raw"],[],[]),
 ("tilapia","Tilapia","seafood",["tilapia","raw"],[],[]),
 ("shrimp","Shrimp","seafood",["crustaceans","shrimp","raw"],[],["prawn"]),
 ("sardines","Sardines, canned","seafood",["sardine","canned","oil","drained"],[],[]),
 ("mackerel","Mackerel","seafood",["mackerel","atlantic","raw"],[],[]),
 ("halibut","Halibut","seafood",["halibut","raw"],[],[]),
 ("scallops","Scallops","seafood",["scallop","raw"],[],[]),
 ("mussels","Mussels","seafood",["mussel","blue","raw"],[],[]),
 # ---- egg & dairy
 ("egg-whole","Egg","egg",["egg","whole","raw","fresh"],["white","yolk","dried"],["eggs","whole egg"]),
 ("egg-white","Egg white","egg",["egg","white","raw","fresh"],["dried"],[]),
 ("egg-yolk","Egg yolk","egg",["egg","yolk","raw","fresh"],["dried"],[]),
 ("milk-whole","Milk, whole","dairy",["milk","whole","3.25%"],["dry","chocolate","evaporated"],[]),
 ("milk-2","Milk, 2%","dairy",["milk","reduced fat","2%","fluid"],["chocolate"],[]),
 ("milk-skim","Milk, skim","dairy",["milk","nonfat","fluid","skim"],["dry","chocolate"],["nonfat milk"]),
 ("yogurt-greek-plain-nonfat","Greek yogurt, plain, nonfat","dairy",["yogurt","greek","plain","nonfat"],[],["greek yoghurt"]),
 ("yogurt-greek-plain-whole","Greek yogurt, plain, whole milk","dairy",["yogurt","greek","plain","whole milk"],[],[]),
 ("yogurt-plain-lowfat","Yogurt, plain, lowfat","dairy",["yogurt","plain","low fat"],["greek"],[]),
 ("cottage-cheese","Cottage cheese, lowfat","dairy",["cheese","cottage","lowfat","2%"],[],[]),
 ("cheddar","Cheddar cheese","dairy",["cheese","cheddar"],["low fat","spread"],[]),
 ("mozzarella","Mozzarella cheese","dairy",["cheese","mozzarella","whole milk"],["low moisture, part"],[]),
 ("parmesan","Parmesan cheese","dairy",["cheese","parmesan","grated"],[],[]),
 ("feta","Feta cheese","dairy",["cheese","feta"],[],[]),
 ("cream-cheese","Cream cheese","dairy",["cheese","cream"],["low fat","fat free"],[]),
 ("butter","Butter","fat_oil",["butter","salted"],["whipped","oil","light"],[]),
 ("heavy-cream","Heavy cream","dairy",["cream","fluid","heavy"],[],["double cream"]),
 ("sour-cream","Sour cream","dairy",["cream","sour","cultured"],["reduced","fat free"],[]),
 # ---- plant protein
 ("tofu-firm","Tofu, firm","plant_protein",["tofu","raw","firm"],["fried","salted"],[]),
 ("tempeh","Tempeh","plant_protein",["tempeh"],["cooked"],[]),
 ("edamame","Edamame","plant_protein",["edamame","frozen","unprepared"],[],["soybeans green"]),
 ("seitan","Vital wheat gluten","plant_protein",["vital wheat gluten"],[],["seitan"]),
 ("soy-milk","Soy milk","plant_protein",["soymilk","unsweetened"],[],["soymilk"]),
 # ---- supplements: what an athlete logs that a nutrient database files oddly
 ("whey-protein","Whey protein powder","supplement",["protein powder whey based"],[],["whey","protein powder","protein shake","protein"]),
 ("soy-protein-powder","Soy protein powder","supplement",["protein powder soy based"],[],["vegan protein"]),
 ("beef-jerky","Beef jerky","supplement",["beef jerky, chopped and formed"],[],["jerky"]),
 ("rice-cake","Rice cakes","grain",["rice cakes, brown rice, plain"],[],["rice cake"]),
 # ---- legumes
 ("black-beans","Black beans, cooked","legume",["beans","black","mature seeds, cooked","without salt"],[],[]),
 ("chickpeas","Chickpeas, cooked","legume",["chickpeas","mature seeds, cooked","without salt"],[],["garbanzo","garbanzo beans","chickpea beans"]),
 ("lentils","Lentils, cooked","legume",["lentils","mature seeds, cooked","without salt"],[],[]),
 ("kidney-beans","Kidney beans, cooked","legume",["beans","kidney","mature seeds, cooked","without salt"],[],[]),
 ("pinto-beans","Pinto beans, cooked","legume",["beans","pinto","mature seeds, cooked","without salt"],[],[]),
 ("peanut-butter","Peanut butter","nut_seed",["peanut butter","smooth"],["reduced","low sodium"],[]),
 ("hummus","Hummus","legume",["hummus","commercial"],[],[]),
 # ---- grains
 ("rice-white-cooked","White rice, cooked","grain",["rice, white, long-grain, regular, cooked"],["instant"],["rice"]),
 ("rice-brown-cooked","Brown rice, cooked","grain",["rice, brown, long-grain, cooked"],[],[]),
 ("oats-dry","Oats, dry","grain",["oats, regular and quick, not fortified, dry"],[],["oatmeal","porridge"]),
 ("quinoa-cooked","Quinoa, cooked","grain",["quinoa, cooked"],[],[]),
 ("pasta-cooked","Pasta, cooked","grain",["pasta, cooked, enriched"],["spinach","whole wheat","protein"],["spaghetti"]),
 ("pasta-whole-wheat","Whole wheat pasta, cooked","grain",["pasta, whole-wheat, cooked"],[],[]),
 ("couscous","Couscous, cooked","grain",["couscous, cooked"],[],[]),
 ("barley","Barley, cooked","grain",["barley, pearled, cooked"],[],[]),
 ("buckwheat","Buckwheat groats, cooked","grain",["buckwheat groats, roasted, cooked"],[],[]),
 ("corn-tortilla","Corn tortilla","grain",["tortillas","corn"],["taco"],[]),
 ("flour-tortilla","Flour tortilla","grain",["tortillas","flour","shelf stable"],[],[]),
 ("bread-white","White bread","grain",["bread, white, commercially prepared"],["toasted","crumbs","reduced"],[]),
 ("bread-whole-wheat","Whole wheat bread","grain",["bread, whole-wheat, commercially prepared"],["toasted"],[]),
 ("bagel","Bagel, plain","grain",["bagels, plain"],["toasted"],[]),
 ("english-muffin","English muffin","grain",["english muffins, plain, enriched"],["toasted","unenriched"],[]),
 ("cereal-corn-flakes","Corn flakes","grain",["cereals ready-to-eat","corn flakes"],["frosted","honey"],[]),
 ("granola","Granola","grain",["granola","homemade"],[],[]),
 # ---- starchy veg
 ("potato-baked","Potato, baked","vegetable",["potatoes, baked, flesh and skin"],[],["potato"]),
 ("sweet-potato-baked","Sweet potato, baked","vegetable",["sweet potato, cooked, baked in skin","without salt"],[],[]),
 ("corn-sweet","Sweet corn","vegetable",["corn, sweet, yellow, raw"],[],[]),
 ("peas-green","Green peas","vegetable",["peas, green, raw"],[],[]),
 # ---- vegetables
 ("broccoli","Broccoli, raw","vegetable",["broccoli, raw"],[],[]),
 ("spinach","Spinach, raw","vegetable",["spinach, raw"],[],[]),
 ("kale","Kale, raw","vegetable",["kale, raw"],[],[]),
 ("carrot","Carrot, raw","vegetable",["carrots, raw"],[],[]),
 ("tomato","Tomato, raw","vegetable",["tomatoes, red, ripe, raw, year round average"],[],[]),
 ("onion","Onion, raw","vegetable",["onions, raw"],["young","spring","dehydrated"],[]),
 ("bell-pepper","Bell pepper, raw","vegetable",["peppers, sweet, red, raw"],[],["capsicum"]),
 ("cucumber","Cucumber, raw","vegetable",["cucumber, with peel, raw"],[],[]),
 ("lettuce-romaine","Romaine lettuce","vegetable",["lettuce, cos or romaine, raw"],[],[]),
 ("mushroom","Mushrooms, raw","vegetable",["mushrooms, white, raw"],[],[]),
 ("zucchini","Zucchini, raw","vegetable",["squash, summer, zucchini, includes skin, raw"],[],["courgette"]),
 ("green-beans","Green beans, raw","vegetable",["beans, snap, green, raw"],[],[]),
 ("asparagus","Asparagus, raw","vegetable",["asparagus, raw"],[],[]),
 ("cauliflower","Cauliflower, raw","vegetable",["cauliflower, raw"],[],[]),
 ("brussels-sprouts","Brussels sprouts","vegetable",["brussels sprouts, raw"],[],[]),
 ("cabbage","Cabbage, raw","vegetable",["cabbage, raw"],["red","chinese","savoy"],[]),
 ("celery","Celery, raw","vegetable",["celery, raw"],[],[]),
 ("beet","Beetroot, raw","vegetable",["beets, raw"],[],["beetroot"]),
 ("eggplant","Aubergine, raw","vegetable",["eggplant, raw"],[],["eggplant"]),
 ("garlic","Garlic, raw","vegetable",["garlic, raw"],[],[]),
 ("avocado","Avocado","fruit",["avocados, raw, all commercial varieties"],[],[]),
 # ---- fruit
 ("banana","Banana","fruit",["bananas, raw"],[],[]),
 ("apple","Apple","fruit",["apples, raw, with skin"],[],[]),
 ("orange","Orange","fruit",["oranges, raw, all commercial varieties"],[],[]),
 ("strawberry","Strawberries","fruit",["strawberries, raw"],[],[]),
 ("blueberry","Blueberries","fruit",["blueberries, raw"],[],[]),
 ("raspberry","Raspberries","fruit",["raspberries, raw"],[],[]),
 ("grape","Grapes","fruit",["grapes, red or green","raw"],[],[]),
 ("mango","Mango","fruit",["mangos, raw"],[],[]),
 ("pineapple","Pineapple","fruit",["pineapple, raw, all varieties"],[],[]),
 ("watermelon","Watermelon","fruit",["watermelon, raw"],[],[]),
 ("peach","Peach","fruit",["peaches, yellow, raw"],[],[]),
 ("pear","Pear","fruit",["pears, raw"],[],[]),
 ("kiwi","Kiwifruit","fruit",["kiwifruit, green, raw"],[],["kiwi"]),
 ("cherry","Cherries","fruit",["cherries, sweet, raw"],[],[]),
 ("date","Dates","fruit",["dates, medjool"],[],[]),
 ("raisin","Raisins, golden","fruit",["raisins, golden, seedless"],[],["raisins"]),
 ("lemon","Lemon","fruit",["lemons, raw, without peel"],[],[]),
 # ---- nuts & seeds
 ("almond","Almonds","nut_seed",["nuts, almonds"],["oil roasted","blanched","butter","milk"],[]),
 ("walnut","Walnuts","nut_seed",["nuts, walnuts, english"],[],[]),
 ("cashew","Cashews","nut_seed",["nuts, cashew nuts, raw"],[],[]),
 ("peanut","Peanuts","nut_seed",["peanuts, all types, raw"],[],[]),
 ("pistachio","Pistachios","nut_seed",["nuts, pistachio nuts, raw"],[],[]),
 ("pecan","Pecans","nut_seed",["nuts, pecans"],["oil roasted"],[]),
 ("chia","Chia seeds","nut_seed",["seeds, chia seeds, dried"],[],[]),
 ("flaxseed","Flaxseed","nut_seed",["seeds, flaxseed"],[],["linseed"]),
 ("pumpkin-seed","Pumpkin seeds","nut_seed",["seeds, pumpkin and squash seed kernels, dried"],[],["pepitas"]),
 ("sunflower-seed","Sunflower seeds","nut_seed",["seeds, sunflower seed kernels, dried"],[],[]),
 ("almond-butter","Almond butter","nut_seed",["nuts, almond butter, plain"],[],[]),
 # ---- fats & oils
 ("olive-oil","Olive oil","fat_oil",["oil, olive, salad or cooking"],[],[]),
 ("coconut-oil","Coconut oil","fat_oil",["oil, coconut"],[],[]),
 ("canola-oil","Canola oil","fat_oil",["oil, canola"],[],["rapeseed oil"]),
 ("avocado-oil","Avocado oil","fat_oil",["oil, avocado"],[],[]),
 ("sesame-oil","Sesame oil","fat_oil",["oil, sesame, salad or cooking"],[],[]),
 # ---- beverages
 ("coffee-brewed","Coffee, brewed","beverage",["beverages, coffee, brewed, prepared with tap water"],["decaf","espresso"],[]),
 ("espresso","Espresso","beverage",["beverages, coffee, brewed, espresso, restaurant-prepared"],["decaf"],[]),
 ("tea-black","Tea, brewed","beverage",["beverages, tea, black, brewed, prepared with tap water"],["decaf"],[]),
 ("orange-juice","Orange juice","beverage",["orange juice, raw"],[],[]),
 ("apple-juice","Apple juice","beverage",["apple juice, canned or bottled, unsweetened"],[],[]),
 ("cola","Cola","beverage",["beverages, carbonated, cola, regular"],["diet"],["coke","soda"]),
 ("beer","Beer, regular","beverage",["alcoholic beverage, beer, regular, all"],["light"],[]),
 ("wine-red","Red wine","beverage",["alcoholic beverage, wine, table, red"],[],[]),
 ("almond-milk","Almond milk, unsweetened","beverage",["beverages, almond milk, unsweetened"],[],[]),
 # ---- condiments & sweeteners
 ("honey","Honey","condiment",["honey"],["mustard"],[]),
 ("maple-syrup","Maple syrup","condiment",["syrups, maple"],[],[]),
 ("ketchup","Ketchup","condiment",["catsup"],["low sodium"],["tomato sauce"]),
 ("mayonnaise","Mayonnaise","condiment",["salad dressing, mayonnaise, regular"],[],[]),
 ("mustard","Mustard","condiment",["mustard, prepared, yellow"],[],[]),
 ("soy-sauce","Soy sauce","condiment",["soy sauce made from soy and wheat"],["low sodium"],[]),
 ("salsa","Salsa","condiment",["sauce, salsa, ready-to-serve"],[],[]),
 ("hot-sauce","Hot sauce","condiment",["sauce, hot chile, sriracha"],[],["sriracha"]),
 ("sugar-white","Sugar, white","condiment",["sugars, granulated"],[],["sugar"]),
 ("balsamic-vinegar","Balsamic vinegar","condiment",["vinegar, balsamic"],[],[]),
 ("salt","Salt","condiment",["salt, table"],[],[]),
 # ---- sweets & snacks
 ("dark-chocolate","Dark chocolate, 70-85%","sweet_snack",["chocolate, dark, 70-85% cacao solids"],[],[]),
 ("milk-chocolate","Milk chocolate","sweet_snack",["candies, milk chocolate"],["coated"],[]),
 ("ice-cream-vanilla","Ice cream, vanilla","sweet_snack",["ice creams, vanilla"],["light","rich"],[]),
 ("potato-chips","Potato chips","sweet_snack",["snacks, potato chips, plain, salted"],["fat free","reduced"],["crisps"]),
 ("tortilla-chips","Tortilla chips","sweet_snack",["snacks, tortilla chips, plain"],["low fat","nacho","taco"],[]),
 ("popcorn","Popcorn, air-popped","sweet_snack",["snacks, popcorn, air-popped"],[],[]),
 ("pretzel","Pretzels","sweet_snack",["snacks, pretzels, hard, plain, salted"],[],[]),
 ("cookie-chocolate-chip","Chocolate chip cookie","sweet_snack",["cookies, chocolate chip, commercially prepared, regular"],[],[]),
 ("granola-bar","Granola bar","sweet_snack",["snacks, granola bars, hard, plain"],[],[]),
 # ---- prepared / fast food
 ("pizza-cheese","Pizza, cheese","prepared",["pizza, cheese topping, regular crust"],[],[]),
 ("hamburger","Hamburger, single patty","prepared",["fast foods, hamburger","single, regular patty","plain"],["condiments"],[]),
 ("french-fries","French fries","prepared",["fast foods, potato, french fried"],[],["chips","fries"]),
 ("burrito-bean","Bean burrito","prepared",["fast foods, burrito, with beans"],["beef"],[]),
]


def load_source(path):
    """Index the SR Legacy dump by fdcId, keeping only what we store."""
    with open(path, encoding="utf-8") as fh:
        raw = json.load(fh)
    foods = raw["SRLegacyFoods"]
    out = []
    for f in foods:
        macros = {}
        for n in f.get("foodNutrients", []):
            nid = n.get("nutrient", {}).get("id")
            if nid in NUTRIENTS and n.get("amount") is not None:
                macros[NUTRIENTS[nid]] = n["amount"]
        # A row with no energy value cannot be logged against a calorie
        # target, so it is not a food this catalog can honestly carry.
        if "kcal" not in macros:
            continue
        out.append({
            "fdc_id": f["fdcId"],
            "desc": f["description"],
            "macros": macros,
        })
    return out


def resolve(index, must, notw):
    """Every SR Legacy row matching all of `must` and none of `notw`.

    Sorted shortest-description-first, then by fdcId. The length rule picks the
    plainest wording — "Peaches, yellow, raw" over "Peaches, yellow, raw
    (Northeast and Midwest region)". **The fdcId tie-break is what makes this
    reproducible**, and it is not decoration: four entries (bacon, sirloin,
    flour tortilla, english muffin) had two candidates of exactly equal length,
    where the winner would otherwise be decided by the order rows happen to sit
    in a 210 MB file. Two of those four picked the wrong food that way —
    `bacon` resolved to "Pork, bacon, rendered fat, cooked", which is not
    bacon. They are disambiguated in SPEC now; the tie-break stops the next one
    being silent.
    """
    hits = [
        row for row in index
        if all(m.lower() in row["desc"].lower() for m in must)
        and not any(w.lower() in row["desc"].lower() for w in notw)
    ]
    hits.sort(key=lambda r: (len(r["desc"]), r["fdc_id"]))
    return hits


def build(index):
    """Resolve every SPEC entry, or fail naming the ones that did not.

    Fails on ANY miss rather than skipping: a spec entry that silently resolves
    to nothing is a food an athlete will search for and not find, which is
    precisely the failure this catalog exists to answer honestly.
    """
    rows, missing, ambiguous = [], [], []
    for slug, name, category, must, notw, aliases in SPEC:
        hits = resolve(index, must, notw)
        if not hits:
            missing.append(slug)
            continue
        if len(hits) > 1 and len(hits[0]["desc"]) == len(hits[1]["desc"]):
            ambiguous.append((slug, hits[0]["desc"], hits[1]["desc"]))
        top = hits[0]
        macros = top["macros"]
        rows.append({
            "id": slug,
            "name": name,
            "category": category,
            "aliases": aliases,
            "kcal": round(float(macros["kcal"]), 2),
            "protein_g": round(float(macros.get("protein_g", 0.0)), 2),
            "carb_g": round(float(macros.get("carb_g", 0.0)), 2),
            "fat_g": round(float(macros.get("fat_g", 0.0)), 2),
            # Absent values stay null rather than becoming 0 — see
            # NULLABLE_NUTRIENTS for why, and migration 000059's argument on
            # nutrition_foods.fibre_g for the original statement of it.
            **{k: (round(float(macros[k]), 2) if k in macros else None)
               for k in NULLABLE_NUTRIENTS},
            "serving_grams": SERVING_GRAMS,
            "market": MARKET,
            "external_id": str(top["fdc_id"]),
            "usda_description": top["desc"],
        })
    if missing:
        raise SystemExit("unresolved spec entries: " + ", ".join(missing))
    if ambiguous:
        for slug, a, b in ambiguous:
            print("ambiguous: %s -> %r vs %r" % (slug, a, b), file=sys.stderr)
        raise SystemExit(
            "%d spec entries are ambiguous; add include/exclude terms"
            % len(ambiguous))
    seen = set()
    for row in rows:
        if row["id"] in seen:
            raise SystemExit("duplicate slug: " + row["id"])
        seen.add(row["id"])
    rows.sort(key=lambda r: r["id"])
    return rows


def render(rows):
    return json.dumps(rows, indent=2, ensure_ascii=False) + "\n"


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("mode", choices=["build", "check"])
    ap.add_argument(
        "--source", required=True,
        help="FoodData_Central_sr_legacy_food_json_2018-04.json (see module docstring)")
    ap.add_argument(
        "--out",
        default=os.path.join("backend", "internal", "modules", "food", "foods.json"))
    args = ap.parse_args()

    rendered = render(build(load_source(args.source)))

    if args.mode == "build":
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(rendered)
        print("wrote %s" % args.out)
        return

    with open(args.out, encoding="utf-8") as fh:
        current = fh.read()
    if current != rendered:
        # Non-zero on purpose. A drift check that only reports is one nobody
        # notices, and this repo already has one of those.
        raise SystemExit(
            "%s is out of date — re-run `build`" % args.out)
    print("%s is up to date" % args.out)


if __name__ == "__main__":
    main()
