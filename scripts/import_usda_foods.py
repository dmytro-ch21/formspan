#!/usr/bin/env python3
"""Build the seeded food catalog from USDA FoodData Central.

The catalog that `GET /v1/nutrition/catalog` searches is version-controlled
JSON, exactly like `exercises.json` and `techniques.json`. This script is how
that JSON is produced, and it is the only thing that may write it by hand.

# What is imported, and why it stopped being 177 rows

This script used to emit **177** foods: it read the whole SR Legacy dump and
then discarded almost all of it, because `SPEC` below was an *inclusion
filter*. The argument was that 7,793 rows would make search worse — USDA's own
relevance ranks *"Lunchmeat, chicken breast, sliced"* above chicken breast, and
the long tail is baby food and school lunches.

That was right about relevance and wrong about the remedy. 177 curated generics
cannot answer "pad thai" or "beef burrito", and an athlete logging dinner is
rarely logging a raw ingredient. So `SPEC` is now a **ranking hint** rather than
a filter: the curated foods keep their hand-written slugs, names and aliases and
are marked `rank_tier` 0 so they sort first; everything else is imported behind
them at tier 1.

Two datasets are imported (N88):

    SR Legacy   7,793 generic foods, frozen at 2018-04
    FNDDS       5,432 cooked and mixed dishes, 2024-10

**FNDDS is the one the catalog never had and the athlete most needs.** It is
the mixed-dish vocabulary — "Chicken breast, fried, coated", "Lobster gumbo",
"Pizza, cheese, from restaurant or fast food, thick crust" — which SR Legacy
does not carry at any row.

# Foundation Foods is DELIBERATELY NOT IMPORTED, and this is the measurement

`--foundation` is accepted and works, and the committed build does not use it.
Measured against the 2026-04-30 release, 363 real rows:

    kcal (nutrient 1008)      95 rows   26%
    sugar (2000)               5 rows    1%
    saturated fat (1258)     105 rows   29%
    descriptions ALSO present VERBATIM in SR Legacy    88 rows   24%

So a quarter of it duplicates SR Legacy exactly, and what is left states almost
no sugar and little saturated fat — which would render as `n/a` across the very
nutrition panel N52 built. 226 further rows carry Atwater energy (2047/2048)
instead of 1008, so importing them at all requires an energy fallback; that
fallback is implemented here so the flag is honest, but the trade is 233 net-new
rows of thin data against a catalog that already has 13,225 complete ones.

Revisit when Foundation's macro coverage improves — it is the dataset USDA is
actively growing, and it is the newest analysis of anything it does cover.

# Branded Foods is out of scope and should stay out

~2 million rows, 3.1 GB unzipped. It cannot be a `go:embed` seed file, and its
relevance would drown the generics. If it lands it belongs behind the barcode
resolver, not in `food_catalog`. See the N88 issue.

# Why bulk files rather than the API

The FoodData Central *API* is not usable for this. `DEMO_KEY` is rate limited
to **30 requests an hour and 50 a day** (measured — the documented figure, and
this script's author hit it), a signed key gets 1,000/hour, and resolving
13,000 foods by search would need at least that many requests. Worse, search
results are not stable over time, so a catalog built from live queries could not
be rebuilt identically tomorrow.

The bulk downloads have neither problem. They need **no API key**:

    BASE=https://fdc.nal.usda.gov/fdc-datasets
    curl -O $BASE/FoodData_Central_sr_legacy_food_json_2018-04.zip
    curl -O $BASE/FoodData_Central_survey_food_json_2024-10-31.zip
    unzip -o 'FoodData_Central_*.zip'
    python3 scripts/import_usda_foods.py build \\
        --sr-legacy FoodData_Central_sr_legacy_food_json_2018-04.json \\
        --survey    surveyDownload.json

Note the Survey zip expands to **`surveyDownload.json`**, not to a dated name
like the others. The zips are deliberately NOT committed — they are 17 MB
compressed and 275 MB expanded, and the JSON this produces is the part anyone
needs to review.

**Reproducibility is now weaker than it was, and that is worth knowing.** SR
Legacy is frozen at 2018-04 and will never change under us. FNDDS is a dated
release (2024-10-31) and USDA ships new ones; Foundation ships roughly every six
months. The filenames above are pinned in this docstring rather than discovered,
so moving to a newer release is a deliberate edit with a reviewable diff, not
something that happens because somebody re-downloaded on a Tuesday.

**USDA FoodData Central is US Government work in the public domain**, published
CC0 1.0 — attribution requested, not required. That is the whole reason it is
the seeded catalog rather than Open Food Facts, which is ODbL: see the comment
on `nutrition_foods.source` in migration 000059, which says an ODbL obligation
"must never reach our own data". Open Food Facts is used for barcode lookups
only, cached in its own table, and never seeded here. Verified against the live
site 2026-08-20.

`--check` rebuilds and diffs against the committed file. It **exits non-zero**
on drift, because a checker that only reports is one nobody notices.

Stdlib only, per the convention for `scripts/*.py`: `verify` runs `check:python`
which only parses, so this must never need a toolchain to be syntax-checked.
"""

import argparse
import collections
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
# **Added sugars (1235) is deliberately NOT here.** Measured across all three
# datasets at N88: SR Legacy 0 rows, FNDDS 0 rows, Foundation 0 rows. Not one
# generic food in FoodData Central states it, so listing it would read as an
# import that silently never fires. Open Food Facts does carry it, so the column
# is populated for scanned products and null for every generic.
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

# Energy, when nutrient 1008 is absent.
#
# Only Foundation needs these: 226 of its 363 rows state Atwater energy and no
# 1008 at all, where SR Legacy and FNDDS state 1008 on every row that has any
# energy. Specific factors are preferred over general ones because they are
# computed per food rather than from the 4/4/9 rule.
#
# Deliberately a FALLBACK and not a member of NUTRIENTS: a row that states both
# must use 1008, or the same food imported from two datasets would disagree with
# itself by a few kcal for no reason a reader could ever discover.
ENERGY_FALLBACK = (2048, 2047)   # Atwater specific, then general

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

# Every value in SR Legacy and FNDDS is per 100 g of the edible portion, so
# every row this writes is per 100 g and the module sets serving_label '100 g'
# for all of them. Household portions ("1 medium banana, 118 g") DO exist in the
# source — 14,449 of them in SR Legacy and 22,194 in FNDDS — and are imported by
# N89, not here.
SERVING_GRAMS = 100

# The market these numbers describe. USDA is a US dataset and the athletes are
# US-primarily, so 'us' is on evidence rather than as a default nobody chose.
# It is a column so that "we do not stock this food" and "we do not cover your
# region" stay different answers later without a migration.
MARKET = "us"

# rank_tier 0 sorts before everything else in a catalog search. It is the only
# thing standing between a curated food and the 803 rows that match "chicken".
TIER_CURATED = 0
TIER_BULK = 1

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

# USDA's category vocabulary, mapped onto the catalog's own 18.
#
# The catalog's categories are NOT decoration: `GET /v1/nutrition/catalog/
# coverage` groups by them so an athlete can be told "we hold 24 vegetables and
# 4 prepared meals" rather than inferring the shape of the catalog from a search
# that found nothing. Passing USDA's vocabulary through unchanged would replace
# that with a 197-row histogram, which answers nothing.
#
# So the 18 stay, and every source category maps onto one of them or is
# EXCLUDED. There is no default: a category this script has never seen is a hard
# failure (see `map_category`), because a silent fallback would quietly file
# hundreds of foods under whatever the fallback happened to be, and the only
# symptom would be a coverage count nobody could explain.
#
# A `None` value means "do not import this category at all", and there are only
# two kinds:
#
#   * **Infant food.** Baby food, formula and human milk. 345 SR Legacy rows and
#     ~152 FNDDS ones. This catalog is for athletes logging their own meals, and
#     the original 2026-08 argument against importing everything named baby food
#     first among the long tail that makes search worse.
#   * **FNDDS recipe fragments.** "Not included in a food category" is 77 rows
#     of dry mixes and components that are not meals: "Beef, for use with
#     vegetables", "Cream sauce, for use with vegetables", "Chocolate beverage
#     powder, dry mix, not reconstituted". Nobody logs those, and the handful
#     that are real foods ("Oats, raw", "Wheat germ") are already in SR Legacy.

SR_CATEGORIES = {
    "Baked Products": "grain",
    "Beef Products": "red_meat",
    "Beverages": "beverage",
    "Breakfast Cereals": "grain",
    "Cereal Grains and Pasta": "grain",
    "Dairy and Egg Products": "dairy",
    "Fast Foods": "prepared",
    "Fats and Oils": "fat_oil",
    "Finfish and Shellfish Products": "seafood",
    "Fruits and Fruit Juices": "fruit",
    "Lamb, Veal, and Game Products": "red_meat",
    "Legumes and Legume Products": "legume",
    "Meals, Entrees, and Side Dishes": "prepared",
    "Nut and Seed Products": "nut_seed",
    "Pork Products": "pork",
    "Poultry Products": "poultry",
    "Restaurant Foods": "prepared",
    "Sausages and Luncheon Meats": "red_meat",
    "Snacks": "sweet_snack",
    "Soups, Sauces, and Gravies": "prepared",
    "Spices and Herbs": "condiment",
    "Sweets": "sweet_snack",
    "Vegetables and Vegetable Products": "vegetable",
    # American Indian/Alaska Native Foods is largely prepared dishes and game;
    # 'prepared' is the honest bucket rather than splitting it by hand.
    "American Indian/Alaska Native Foods": "prepared",
    "Baby Foods": None,
}

WWEIA_CATEGORIES = {
    "Apple juice": "beverage",
    "Apples": "fruit",
    "Bacon": "pork",
    "Bagels and English muffins": "grain",
    "Bananas": "fruit",
    "Bean, pea, legume dishes": "legume",
    "Beans, peas, legumes": "legume",
    "Beef, excludes ground": "red_meat",
    "Beer": "beverage",
    "Biscuits, muffins, quick breads": "grain",
    "Blueberries and other berries": "fruit",
    "Bottled water": "beverage",
    "Broccoli": "vegetable",
    "Burgers": "prepared",
    "Burritos and tacos": "prepared",
    "Butter and animal fats": "fat_oil",
    "Cabbage": "vegetable",
    "Cakes and pies": "sweet_snack",
    "Candy containing chocolate": "sweet_snack",
    "Candy not containing chocolate": "sweet_snack",
    "Carrots": "vegetable",
    "Cereal bars": "sweet_snack",
    "Cheese": "dairy",
    "Cheese sandwiches": "prepared",
    "Chicken fillet sandwiches": "prepared",
    "Chicken patties, nuggets and tenders": "poultry",
    "Chicken, whole pieces": "poultry",
    "Citrus fruits": "fruit",
    "Citrus juice": "beverage",
    "Coffee": "beverage",
    "Cold cuts and cured meats": "red_meat",
    "Coleslaw, non-lettuce salads": "vegetable",
    "Cookies and brownies": "sweet_snack",
    "Corn": "vegetable",
    "Cottage/ricotta cheese": "dairy",
    "Crackers, excludes saltines": "sweet_snack",
    "Cream and cream substitutes": "dairy",
    "Cream cheese, sour cream, whipped cream": "dairy",
    "Deli and cured meat sandwiches": "prepared",
    "Diet soft drinks": "beverage",
    "Diet sport and energy drinks": "beverage",
    "Dips, gravies, other sauces": "condiment",
    "Doughnuts, sweet rolls, pastries": "sweet_snack",
    "Dried fruits": "fruit",
    "Egg rolls, dumplings, sushi": "prepared",
    "Egg/breakfast sandwiches": "prepared",
    "Eggs and omelets": "egg",
    "Enhanced water": "beverage",
    "Fish": "seafood",
    "Flavored milk, lowfat": "dairy",
    "Flavored milk, nonfat": "dairy",
    "Flavored milk, reduced fat": "dairy",
    "Flavored milk, whole": "dairy",
    "Flavored or carbonated water": "beverage",
    "Frankfurter sandwiches": "prepared",
    "Frankfurters": "red_meat",
    "French fries and other fried white potatoes": "vegetable",
    "Fried rice and lo/chow mein": "prepared",
    "Fried vegetables": "vegetable",
    "Fruit drinks": "beverage",
    "Gelatins, ices, sorbets": "sweet_snack",
    "Grapes": "fruit",
    "Grits and other cooked cereals": "grain",
    "Ground beef": "red_meat",
    "Ice cream and frozen dairy desserts": "sweet_snack",
    "Jams, syrups, toppings": "condiment",
    "Lamb, goat, game": "red_meat",
    "Lettuce and lettuce salads": "vegetable",
    "Liquor and cocktails": "beverage",
    "Liver and organ meats": "red_meat",
    "Macaroni and cheese": "prepared",
    "Mango and papaya": "fruit",
    "Margarine": "fat_oil",
    "Mashed potatoes and white potato mixtures": "vegetable",
    "Mayonnaise": "condiment",
    "Meat and BBQ sandwiches": "prepared",
    "Meat mixed dishes": "prepared",
    "Melons": "fruit",
    "Milk shakes and other dairy drinks": "beverage",
    "Milk, lowfat": "dairy",
    "Milk, nonfat": "dairy",
    "Milk, reduced fat": "dairy",
    "Milk, whole": "dairy",
    "Mustard and other condiments": "condiment",
    "Nachos": "prepared",
    "Nutrition bars": "supplement",
    "Nutritional beverages": "supplement",
    "Nuts and seeds": "nut_seed",
    "Oatmeal": "grain",
    "Olives, pickles, pickled vegetables": "vegetable",
    "Onions": "vegetable",
    "Other Mexican mixed dishes": "prepared",
    "Other dark green vegetables": "vegetable",
    "Other diet drinks": "beverage",
    "Other fruit juice": "beverage",
    "Other fruits and fruit salads": "fruit",
    "Other red and orange vegetables": "vegetable",
    "Other starchy vegetables": "vegetable",
    "Other vegetables and combinations": "vegetable",
    "Pancakes, waffles, French toast": "grain",
    "Pasta mixed dishes, excludes macaroni and cheese": "prepared",
    "Pasta sauces, tomato-based": "condiment",
    "Pasta, noodles, cooked grains": "grain",
    "Peaches and nectarines": "fruit",
    "Peanut butter and jelly sandwiches": "prepared",
    "Pears": "fruit",
    "Pineapple": "fruit",
    "Pizza": "prepared",
    "Plant-based milk": "plant_protein",
    "Plant-based yogurt": "plant_protein",
    "Popcorn": "sweet_snack",
    "Pork": "pork",
    "Potato chips": "sweet_snack",
    "Poultry mixed dishes": "prepared",
    "Pretzels/snack mix": "sweet_snack",
    "Protein and nutritional powders": "supplement",
    "Pudding": "sweet_snack",
    "Ramen and Asian broth-based soups": "prepared",
    "Ready-to-eat cereal, higher sugar (>21.2g/100g)": "grain",
    "Ready-to-eat cereal, lower sugar (=<21.2g/100g)": "grain",
    "Rice": "grain",
    "Rice mixed dishes": "prepared",
    "Rolls and buns": "grain",
    "Salad dressings and vegetable oils": "fat_oil",
    "Saltine crackers": "sweet_snack",
    "Sausages": "pork",
    "Seafood mixed dishes": "prepared",
    "Seafood sandwiches": "prepared",
    "Shellfish": "seafood",
    "Smoothies and grain drinks": "beverage",
    "Soft drinks": "beverage",
    "Soups, broth-based": "prepared",
    "Soups, cream-based": "prepared",
    "Soy and meat-alternative products": "plant_protein",
    "Soy-based condiments": "condiment",
    "Spinach": "vegetable",
    "Sport and energy drinks": "beverage",
    "Stir-fry and soy-based sauce mixtures": "prepared",
    "Strawberries": "fruit",
    "String beans": "vegetable",
    "Sugar substitutes": "condiment",
    "Sugars and honey": "condiment",
    "Tap water": "beverage",
    "Tea": "beverage",
    "Tomato-based condiments": "condiment",
    "Tomatoes": "vegetable",
    "Tortilla, corn, other chips": "sweet_snack",
    "Tortillas": "grain",
    "Turkey, duck, other poultry": "poultry",
    "Turnovers and other grain-based items": "grain",
    "Vegetable dishes": "vegetable",
    "Vegetable juice": "beverage",
    "Vegetable sandwiches/burgers": "prepared",
    "Vegetables on a sandwich": "vegetable",
    "White potatoes, baked or boiled": "vegetable",
    "Wine": "beverage",
    "Yeast breads": "grain",
    "Yogurt, Greek": "dairy",
    "Yogurt, regular": "dairy",
    # Infant food — see the comment above SR_CATEGORIES.
    "Baby food: cereals": None,
    "Baby food: fruit": None,
    "Baby food: meat and dinners": None,
    "Baby food: mixtures": None,
    "Baby food: snacks and sweets": None,
    "Baby food: vegetables": None,
    "Baby food: yogurt": None,
    "Baby juice": None,
    "Baby water": None,
    "Formula, prepared from powder": None,
    "Formula, ready-to-feed": None,
    "Human milk": None,
    # Recipe fragments and dry mixes, not meals.
    "Not included in a food category": None,
}

# Categories that the source files eft to the description.
#
# SR Legacy files eggs under "Dairy and Egg Products", so without this every egg
# row would be counted as a dairy food by the coverage endpoint — including the
# rows the curated set already calls `egg`. Matched on a leading token so
# "Eggnog" and "Eggplant" are untouched; both exist in SR Legacy and neither is
# an egg.
#
# Kept deliberately tiny. This is a place a hundred hand-written special cases
# could accumulate, and each one is a rule nobody will remember to re-check
# against a future release.
DESCRIPTION_CATEGORIES = (
    ("Egg, ", "egg"),
    ("Eggs, ", "egg"),
)

# The 18 the catalog uses. Every mapping above must land in here, and
# `check_categories` proves it rather than trusting the tables to stay in step.
CATALOG_CATEGORIES = {
    "beverage", "condiment", "dairy", "egg", "fat_oil", "fruit", "grain",
    "legume", "nut_seed", "plant_protein", "pork", "poultry", "prepared",
    "red_meat", "seafood", "supplement", "sweet_snack", "vegetable",
}


# Portions the source states but that are not a portion of food (N89).
#
# FNDDS ships 5,363 rows described as "Quantity not specified" — one of them
# with a gramWeight of literally 0 — and 314 "Guideline amount per cup of hot
# cereal" style entries, which are recipe-building amounts for the survey's own
# analysts rather than a way anybody eats a food. Both would show up in a
# portion picker as an option that means nothing.
#
# Matched on the description because that is what the source gives us; there is
# no flag distinguishing them.
PORTION_EXCLUDE_EXACT = ("Quantity not specified",)
PORTION_EXCLUDE_PREFIX = ("Guideline amount",)

# The longest label observed is 114 characters (FNDDS); the column allows 120.
MAX_PORTION_LABEL = 120


def portion_label(portion, dataset):
    """The phrase a person would say, or None if this portion is unusable.

    **The two datasets describe portions in genuinely different shapes**, and
    this is the one place that difference is resolved:

      SR Legacy / Foundation   `amount` + `modifier`, e.g. 1 + "waffle, round"
                               `measureUnit.name` is the literal string
                               "undetermined" on ALL 14,449 SR Legacy portions,
                               so it is useless here and deliberately unread.
      FNDDS                    a ready-made `portionDescription` ("1 cup"), no
                               `amount` at all, and a `modifier` holding a bare
                               numeric code ("63480") that must never be shown.

    Reading `modifier` for FNDDS — the obvious thing, since SR Legacy uses it —
    would put "63480" in front of an athlete as a serving size.
    """
    grams = portion.get("gramWeight")
    # Zero is not a small portion, it is an absent one. FNDDS ships exactly one.
    if not grams or grams <= 0:
        return None

    if dataset == "fndds":
        label = (portion.get("portionDescription") or "").strip()
    else:
        modifier = (portion.get("modifier") or "").strip()
        if not modifier:
            return None
        amount = portion.get("amount")
        if amount is None:
            # Defaulting to "1" would state a quantity the source never gave —
            # a guess in the confident direction, displayed to an athlete as a
            # serving size. Dropped instead. Believed unreachable (every SR
            # Legacy portion measured carries `amount`), which is exactly why it
            # must not silently invent one if that ever stops being true.
            return None
        # "%g" so 1.0 renders as "1" and 0.5 stays "0.5".
        label = "%s %s" % ("%g" % amount, modifier)

    if not label:
        return None
    if label in PORTION_EXCLUDE_EXACT:
        return None
    if any(label.startswith(pre) for pre in PORTION_EXCLUDE_PREFIX):
        return None
    if len(label) > MAX_PORTION_LABEL:
        # Fails rather than truncating: a portion label is short by nature, so
        # one over the limit means the shape changed and somebody should look.
        raise SystemExit("portion label too long (%d): %r" % (len(label), label))
    return label


def portions_for(food, dataset):
    """Every usable portion on one source row, in USDA's own sequence order.

    `sequenceNumber` is verified unique within a food across both datasets, so
    it is safe as half the primary key; a collision would mean the source
    changed shape and is worth failing on rather than silently dropping one.
    """
    out, seen = [], set()
    for p in food.get("foodPortions") or []:
        if not isinstance(p, dict):
            continue
        label = portion_label(p, dataset)
        if label is None:
            continue
        seq = p.get("sequenceNumber")
        if seq is None:
            continue
        if seq in seen:
            raise SystemExit(
                "duplicate portion sequenceNumber %r on fdcId %s"
                % (seq, food.get("fdcId")))
        seen.add(seq)
        out.append({"seq": int(seq),
                    "label": label,
                    "grams": round(float(p["gramWeight"]), 2)})
    out.sort(key=lambda r: r["seq"])
    return out


def check_categories():
    """Fail if a mapping table names a category the catalog does not have.

    A typo here would not raise anywhere else — it would produce a `food_catalog`
    row with a category no client filters on and the coverage endpoint reports as
    its own group, which looks like data rather than a bug.
    """
    bad = set()
    for table in (SR_CATEGORIES, WWEIA_CATEGORIES):
        bad |= {v for v in table.values()
                if v is not None and v not in CATALOG_CATEGORIES}
    bad |= {v for _, v in DESCRIPTION_CATEGORIES if v not in CATALOG_CATEGORIES}
    if bad:
        raise SystemExit("categories not in the catalog's set: "
                         + ", ".join(sorted(bad)))


def map_category(table, source_name, description):
    """The catalog category for one source row, or None to skip it.

    Raises on an unknown source category rather than defaulting. A USDA release
    that adds a category would otherwise file its foods under whatever the
    fallback was, silently, and the only visible symptom would be a coverage
    count nobody could account for.
    """
    for prefix, cat in DESCRIPTION_CATEGORIES:
        if description.startswith(prefix):
            return cat
    if source_name not in table:
        raise SystemExit(
            "unmapped source category %r (row: %r) — add it to the table in "
            "scripts/import_usda_foods.py" % (source_name, description))
    return table[source_name]


def nutrient_id(entry):
    """The USDA nutrient id on one foodNutrients entry.

    Two shapes exist across the datasets — a nested `nutrient` object, and a
    flat `nutrientId` — so this reads both rather than assuming the one the
    dataset in front of it happens to use.
    """
    nested = entry.get("nutrient")
    if isinstance(nested, dict):
        return nested.get("id")
    return entry.get("nutrientId")


def load_dataset(path, key, category_table, dataset):
    """Index one FDC dump, keeping only the rows and nutrients we store.

    **Null entries are real.** The 2026-04-30 Foundation file carries 32 literal
    `null`s in its `FoundationFoods` array — measured, not defensive
    programming — so a loader that trusts every element to be an object crashes
    on a file USDA publishes. Skipped rather than counted.
    """
    with open(path, encoding="utf-8") as fh:
        raw = json.load(fh)
    if key not in raw:
        raise SystemExit("%s has no %r key — wrong dataset for this flag?"
                         % (path, key))

    out, skipped_no_energy, skipped_category = [], 0, 0
    for f in raw[key]:
        if not isinstance(f, dict):
            continue
        macros = {}
        energy_alt = {}
        for n in f.get("foodNutrients") or []:
            if not isinstance(n, dict) or n.get("amount") is None:
                continue
            nid = nutrient_id(n)
            if nid in NUTRIENTS:
                macros[NUTRIENTS[nid]] = n["amount"]
            elif nid in ENERGY_FALLBACK:
                energy_alt[nid] = n["amount"]
        if "kcal" not in macros:
            # Atwater energy, in the fixed preference order, and only when 1008
            # is genuinely absent.
            for nid in ENERGY_FALLBACK:
                if nid in energy_alt:
                    macros["kcal"] = energy_alt[nid]
                    break
        # A row with no energy value cannot be logged against a calorie
        # target, so it is not a food this catalog can honestly carry.
        if "kcal" not in macros:
            skipped_no_energy += 1
            continue

        description = f["description"]
        source_category = (
            (f.get("foodCategory") or {}).get("description")
            if category_table is SR_CATEGORIES
            else (f.get("wweiaFoodCategory") or {})
            .get("wweiaFoodCategoryDescription")
        )
        if source_category is None:
            skipped_category += 1
            continue
        category = map_category(category_table, source_category, description)
        if category is None:
            skipped_category += 1
            continue

        out.append({
            "fdc_id": f["fdcId"],
            "desc": description,
            "category": category,
            "macros": macros,
            "portions": portions_for(f, dataset),
        })
    return out, skipped_no_energy, skipped_category


def resolve(index, must, notw):
    """Every source row matching all of `must` and none of `notw`.

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


# Rows where a core macro was absent and became 0.0. Counted rather than
# silenced: NOT NULL forces a value, so unlike the nullable nutrients this one
# genuinely cannot record "unknown" — which makes it the one place this script
# states something the source did not. A count on stderr keeps that visible
# instead of letting it hide behind the schema.
DEFAULTED_MACROS = collections.Counter()


def macro_fields(macros):
    """The nine nutrient fields, with absence carried through as null.

    `kcal`/`protein_g`/`carb_g`/`fat_g` are NOT NULL in the schema, so an absent
    one becomes 0.0 and is tallied in DEFAULTED_MACROS. The other five stay NULL,
    per the rule that absence is a fact about the source rather than the food.
    """
    for k in ("protein_g", "carb_g", "fat_g"):
        if k not in macros:
            DEFAULTED_MACROS[k] += 1
    fields = {
        "kcal": round(float(macros["kcal"]), 2),
        "protein_g": round(float(macros.get("protein_g", 0.0)), 2),
        "carb_g": round(float(macros.get("carb_g", 0.0)), 2),
        "fat_g": round(float(macros.get("fat_g", 0.0)), 2),
    }
    # Absent values stay null rather than becoming 0 — see NULLABLE_NUTRIENTS
    # for why, and migration 000059's argument on nutrition_foods.fibre_g for
    # the original statement of it.
    for k in NULLABLE_NUTRIENTS:
        fields[k] = round(float(macros[k]), 2) if k in macros else None
    return fields


def build_curated(sr_index):
    """Resolve every SPEC entry against SR Legacy, or fail naming the misses.

    Fails on ANY miss rather than skipping: a spec entry that silently resolves
    to nothing is a food an athlete will search for and not find, which is
    precisely the failure this catalog exists to answer honestly.

    Returns the rows and the set of fdcIds they claimed, so the bulk pass can
    leave those source rows alone — importing one twice would put the same food
    in the catalog under both a curated slug and a `usda-` id, and the
    duplicate would rank directly beneath the row it duplicates.
    """
    rows, missing, ambiguous, claimed = [], [], [], set()
    for slug, name, category, must, notw, aliases in SPEC:
        hits = resolve(sr_index, must, notw)
        if not hits:
            missing.append(slug)
            continue
        if len(hits) > 1 and len(hits[0]["desc"]) == len(hits[1]["desc"]):
            ambiguous.append((slug, hits[0]["desc"], hits[1]["desc"]))
        top = hits[0]
        claimed.add(top["fdc_id"])
        rows.append({
            "id": slug,
            "name": name,
            "category": category,
            "rank_tier": TIER_CURATED,
            "aliases": aliases,
            **macro_fields(top["macros"]),
            "serving_grams": SERVING_GRAMS,
            "market": MARKET,
            "external_id": str(top["fdc_id"]),
            "usda_description": top["desc"],
            "portions": top["portions"],
        })
    if missing:
        raise SystemExit("unresolved spec entries: " + ", ".join(missing))
    if ambiguous:
        for slug, a, b in ambiguous:
            print("ambiguous: %s -> %r vs %r" % (slug, a, b), file=sys.stderr)
        raise SystemExit(
            "%d spec entries are ambiguous; add include/exclude terms"
            % len(ambiguous))
    return rows, claimed


def build_bulk(indexes, claimed):
    """Every remaining source row, at tier 1.

    The id is `usda-<fdcId>`: it satisfies the `food_catalog` primary key's
    slug CHECK, and it is STABLE — the same USDA row keeps the same catalog id
    across every rebuild, forever, which is what lets a re-import update a row
    rather than orphan it. It is deliberately not derived from the description,
    because descriptions get revised between releases and a slug that moves is a
    row that silently duplicates itself.

    `aliases` is empty for these. Aliases are hand-written per food — 'ahi' for
    yellowfin tuna — and inventing them from a description would put words in
    the catalog that no source states.
    """
    rows, seen = [], set()
    for index in indexes:
        for row in index:
            if row["fdc_id"] in claimed or row["fdc_id"] in seen:
                continue
            seen.add(row["fdc_id"])
            rows.append({
                "id": "usda-%d" % row["fdc_id"],
                "name": row["desc"],
                "category": row["category"],
                "rank_tier": TIER_BULK,
                "aliases": [],
                **macro_fields(row["macros"]),
                "serving_grams": SERVING_GRAMS,
                "market": MARKET,
                "external_id": str(row["fdc_id"]),
                "portions": row["portions"],
            })
    return rows


def build(sr_index, extra_indexes):
    curated, claimed = build_curated(sr_index)
    rows = curated + build_bulk([sr_index] + extra_indexes, claimed)
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
        "--sr-legacy", required=True,
        help="FoodData_Central_sr_legacy_food_json_2018-04.json")
    ap.add_argument(
        "--survey", required=True,
        help="surveyDownload.json, from the FNDDS zip (note the name)")
    ap.add_argument(
        "--foundation",
        help="FoodData_Central_foundation_food_json_*.json. Accepted, and "
             "deliberately NOT part of the committed build — see the module "
             "docstring for the coverage measurement that decided that.")
    ap.add_argument(
        "--out",
        default=os.path.join("backend", "internal", "modules", "food", "foods.json"))
    args = ap.parse_args()

    check_categories()

    sr_index, sr_noenergy, sr_nocat = load_dataset(
        args.sr_legacy, "SRLegacyFoods", SR_CATEGORIES, "sr")
    survey_index, sv_noenergy, sv_nocat = load_dataset(
        args.survey, "SurveyFoods", WWEIA_CATEGORIES, "fndds")
    extra = [survey_index]
    if args.foundation:
        found_index, fd_noenergy, fd_nocat = load_dataset(
            args.foundation, "FoundationFoods", SR_CATEGORIES, "sr")
        extra.append(found_index)
        print("foundation: %d usable, %d without energy, %d excluded by category"
              % (len(found_index), fd_noenergy, fd_nocat), file=sys.stderr)

    print("sr_legacy: %d usable, %d without energy, %d excluded by category"
          % (len(sr_index), sr_noenergy, sr_nocat), file=sys.stderr)
    print("survey:    %d usable, %d without energy, %d excluded by category"
          % (len(survey_index), sv_noenergy, sv_nocat), file=sys.stderr)

    rows = build(sr_index, extra)
    curated = sum(1 for r in rows if r["rank_tier"] == TIER_CURATED)
    portions = sum(len(r["portions"]) for r in rows)
    with_portions = sum(1 for r in rows if r["portions"])
    print("catalog:   %d rows (%d curated, %d bulk)"
          % (len(rows), curated, len(rows) - curated), file=sys.stderr)
    print("portions:  %d across %d rows (%.0f%% of the catalog has one)"
          % (portions, with_portions, 100.0 * with_portions / len(rows)),
          file=sys.stderr)
    if DEFAULTED_MACROS:
        # Not fatal — a food with energy but no stated protein is still
        # loggable — but it is the one number in the output the source did not
        # state, so it is said out loud rather than left to a reader to notice.
        print("defaulted to 0.0 (source stated nothing): %s"
              % ", ".join("%s x%d" % (k, n)
                          for k, n in sorted(DEFAULTED_MACROS.items())),
              file=sys.stderr)

    rendered = render(rows)

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
